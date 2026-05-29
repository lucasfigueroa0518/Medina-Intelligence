// TRD §12.2 — CampaignSendWorkflow: step-per-recipient with 429 retry handling
import type { Env } from '../types/env';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { sendViaOutlook } from '../integrations/outlook-send';
import { resolveVariables } from '../lib/variables';
import { emitAudit } from '../lib/audit';

interface CampaignParams {
  campaign_id: string;
  org_id: string;
}

export class CampaignSendWorkflow extends WorkflowEntrypoint<Env, CampaignParams> {
  async run(event: WorkflowEvent<CampaignParams>, step: WorkflowStep): Promise<void> {
    const { campaign_id, org_id } = event.payload;

    // Step 1: load + validate sender token
    const campaign = await step.do('load-campaign', async () => {
      const c = await this.env.D1.prepare(
        'SELECT * FROM email_campaigns WHERE id = ? AND org_id = ?'
      ).bind(campaign_id, org_id).first<any>();
      if (!c) throw new Error('Campaign not found');
      if (!c.sender_user_id) throw new Error('No sender configured');

      await this.env.D1.prepare(
        `UPDATE email_campaigns SET status = 'sending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind(campaign_id).run();

      return c;
    });

    // Step 2: load pending recipients
    const recipients = await step.do('load-recipients', async () => {
      const rows = await this.env.D1.prepare(
        `SELECT ecr.id as recipient_id, ecr.contact_id, ecr.email,
                c.full_name, c.job_title, c.company_id, c.custom_fields,
                comp.name as company_name
         FROM email_campaign_recipients ecr
         JOIN contacts c ON ecr.contact_id = c.id
         LEFT JOIN companies comp ON c.company_id = comp.id
         LEFT JOIN merge_locks ml ON c.id = ml.contact_id
           AND ml.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE ecr.campaign_id = ? AND ecr.status = 'pending'
           AND c.deleted_at IS NULL AND ml.contact_id IS NULL`
      ).bind(campaign_id).all<any>();
      return rows.results;
    });

    let totalSent = 0;
    let totalFailed = 0;

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];

      await step.do(
        `send-${recipient.recipient_id}`,
        { retries: { limit: 3, delay: '30 seconds' } },
        async () => {
          const body = resolveVariables(campaign.body_template as string, {
            full_name: recipient.full_name || '',
            job_title: recipient.job_title || '',
            company_name: recipient.company_name || '',
            custom_fields: recipient.custom_fields,
          });

          const result = await sendViaOutlook(
            {
              senderUserId: campaign.sender_user_id,
              orgId: org_id,
              subject: campaign.subject,
              body,
              toEmail: recipient.email,
            },
            this.env
          );

          if (result.status === 429 && result.retryAfter) {
            await step.sleep('retry-backoff', `${result.retryAfter} seconds`);
            throw new Error(
              `OUTLOOK_SEND_RATE_LIMITED: retry after ${result.retryAfter}s`
            );
          }

          if (!result.ok) {
            // Permanent failure — mark recipient and continue
            await this.env.D1.prepare(
              `UPDATE email_campaign_recipients SET status = 'failed', error_message = ? WHERE id = ?`
            ).bind(result.errorMessage?.slice(0, 500) || 'unknown', recipient.recipient_id).run();
            totalFailed++;
            return;
          }

          await this.env.D1.prepare(
            `UPDATE email_campaign_recipients SET status = 'sent', sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
          ).bind(recipient.recipient_id).run();
          totalSent++;
        }
      );

      if (i < recipients.length - 1) {
        await step.sleep('throttle', '1 second');
      }
    }

    // Finalize
    await step.do('finalize', async () => {
      await this.env.D1.prepare(
        `UPDATE email_campaigns
         SET status = 'sent', sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             total_sent = ?, total_failed = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      ).bind(totalSent, totalFailed, campaign_id).run();

      await emitAudit(this.env, {
        org_id,
        user_id: campaign.created_by || undefined,
        action: 'campaign_send',
        entity_type: 'campaign',
        entity_id: campaign_id,
        metadata: {
          total_sent: totalSent,
          total_failed: totalFailed,
          sender_user_id: campaign.sender_user_id,
        },
        created_at: new Date().toISOString(),
      });
    });
  }
}
