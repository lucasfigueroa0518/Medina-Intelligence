'use client';

import { ContactDetailContent } from '../[id]/page';
import { DEMO_IDS } from '@/lib/demo-mode';

export default function DemoDonaldTrumpContactPage() {
  return <ContactDetailContent forcedId={DEMO_IDS.contact} />;
}
