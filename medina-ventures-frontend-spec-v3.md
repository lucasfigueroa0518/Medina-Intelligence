# Medina Ventures — Intelligence Platform
## Frontend Specification & UX Guide
### Version 3.0 | Companion to TRD v3.0

---

> **Scope:** This document specifies the frontend user interface and experience for the Medina Ventures Intelligence Platform. It covers navigation, page layouts, component behavior, interaction states, data flow, and visual design. It does NOT duplicate backend logic, schemas, or API contracts — those live in the TRD v3.0, referenced by section number throughout.
>
> **Build Stack:** Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui component library. See TRD §22 for the project file structure.
>
> **Design Priorities:**
> 1. **Intuitive and user-friendly.** A managing partner with zero training should be able to navigate the CRM, ask God Mode a question, and review an approval queue item within 5 minutes of first login.
> 2. **Every route works correctly.** No dead ends, no broken states, no spinners that never resolve. Every loading, empty, error, and success state is specified.
>
> **Visual Direction:** Dark theme. Easy on the eyes. Clean white buttons and elements. Purple/pink gradients for accents — drawn directly from the Medina Ventures logo.

---

## Table of Contents

1. [Design System](#1-design-system)
2. [Navigation & Layout](#2-navigation--layout)
3. [Shared Components](#3-shared-components)
4. [Contacts](#4-contacts)
5. [Companies](#5-companies)
6. [Deals](#6-deals)
7. [God Mode](#7-god-mode)
8. [Email Campaigns](#8-email-campaigns)
9. [Admin Dashboard](#9-admin-dashboard)
10. [Settings](#10-settings)
11. [Imports](#11-imports)
12. [Responsive & Mobile Behavior](#12-responsive--mobile-behavior)
13. [Keyboard Shortcuts](#13-keyboard-shortcuts)

---

## 1. Design System

### 1.1 Color Palette

The UI uses a dark theme with the Medina Ventures brand gradient as the accent. All surfaces are dark gray — never pure black — to create depth through subtle contrast. Interactive elements use white or near-white text on dark backgrounds. The brand gradient (magenta → purple) is reserved for primary actions, active states, and emphasis — never for large surface areas.

```
Background & Surfaces
──────────────────────────────────────────────
--bg-root:          #09090B      App background (darkest)
--bg-surface:       #111114      Card/panel background
--bg-surface-hover: #1A1A1F      Card/panel hover state
--bg-elevated:      #222228      Modals, dropdowns, popovers
--bg-input:         #161619      Input field backgrounds
--bg-inset:         #0D0D0F      Inset areas (filter sidebar, chat history)

Borders
──────────────────────────────────────────────
--border-default:   #27272A      Default borders (subtle)
--border-hover:     #3F3F46      Borders on hover
--border-active:    #D946A8      Borders on focus/active (brand magenta)

Text
──────────────────────────────────────────────
--text-primary:     #FAFAFA      Headings, primary content
--text-secondary:   #A1A1AA      Descriptions, secondary labels
--text-muted:       #71717A      Placeholder text, disabled states
--text-inverse:     #09090B      Text on white/light buttons

Brand Gradient (accent only)
──────────────────────────────────────────────
--gradient:         linear-gradient(135deg, #D946A8, #8B5CF6)
--accent-magenta:   #D946A8      Primary accent
--accent-purple:    #8B5CF6      Secondary accent
--accent-glow:      rgba(217, 70, 168, 0.12)   Hover glow on accent elements

Semantic Colors
──────────────────────────────────────────────
--success:          #22C55E      Confirmed, sent, approved
--warning:          #F59E0B      Pending, scheduled, attention needed
--error:            #EF4444      Failed, rejected
--info:             #3B82F6      Informational badges, links
```

### 1.2 Typography

```
Font Family
──────────────────────────────────────────────
--font-sans:        'DM Sans', system-ui, -apple-system, sans-serif
--font-display:     'Instrument Serif', Georgia, serif

Usage
──────────────────────────────────────────────
Page titles:        Instrument Serif, 32px, weight 400, --text-primary
Section headings:   DM Sans, 18px, weight 500, --text-primary
Card titles:        DM Sans, 15px, weight 500, --text-primary
Body text:          DM Sans, 14px, weight 400, --text-secondary
Small labels:       DM Sans, 12px, weight 500, --text-muted, letter-spacing 0.5px
Table headers:      DM Sans, 12px, weight 500, --text-muted, uppercase, letter-spacing 1px
Monospace (IDs):    'JetBrains Mono', monospace, 12px
```

### 1.3 Spacing & Layout

```
Spacing Scale (Tailwind)
──────────────────────────────────────────────
4px   (p-1)    Tight inner padding (badge text)
8px   (p-2)    Input inner padding, icon spacing
12px  (p-3)    Card inner padding (compact cards)
16px  (p-4)    Standard inner padding
24px  (p-6)    Section spacing within a page
32px  (p-8)    Spacing between major sections
48px  (p-12)   Page top padding

Border Radius
──────────────────────────────────────────────
Buttons:        8px  (rounded-lg)
Cards:          12px (rounded-xl)
Inputs:         8px  (rounded-lg)
Badges/pills:   9999px (rounded-full)
Modals:         16px (rounded-2xl)
Avatars:        9999px (rounded-full)
```

### 1.4 Buttons

Three tiers. Use the highest tier that matches the action's importance on the page — never more than one primary button per view.

```
Primary (gradient):
  Background: var(--gradient)
  Text: white, 14px, weight 500
  Padding: 10px 20px
  Border: none
  Hover: brightness(1.1), subtle scale(1.01)
  Used for: "Add Contact", "Send Campaign", "Approve", "Save"
  
Secondary (white outline):
  Background: transparent
  Text: --text-primary, 14px, weight 400
  Border: 1px solid --border-default
  Padding: 10px 20px
  Hover: background --bg-surface-hover, border --border-hover
  Used for: "Cancel", "Export CSV", "View Details", "Clear Filters"

Ghost (text only):
  Background: transparent
  Text: --text-secondary, 14px, weight 400
  Border: none
  Padding: 8px 12px
  Hover: text --text-primary, background rgba(255,255,255,0.04)
  Used for: Toolbar actions, "Show more", "View all", breadcrumb links

Destructive (red outline — used sparingly):
  Background: transparent
  Text: --error, 14px, weight 400
  Border: 1px solid rgba(239, 68, 68, 0.3)
  Hover: background rgba(239, 68, 68, 0.08)
  Used for: "Delete", "Discard", "Reject"
```

### 1.5 Interaction Principles

**No dead ends.** Every empty state has a call to action. An empty contact list shows "No contacts match your filters" with a "Clear filters" link and an "Add Contact" button. An empty God Mode session shows a prompt suggestion grid.

**No mystery spinners.** Loading states always describe what's loading. "Loading contacts..." not just a spinner. Skeleton screens for table rows — gray pulsing bars that match the column layout.

**Optimistic updates.** When a user applies a tag, the tag pill appears immediately in the UI. The API call fires in the background. If it fails, the tag is removed with a brief toast: "Failed to apply tag. Please try again." Same for approval/rejection, drag-and-drop deal stage changes, and task status updates.

**Toasts for confirmations.** Non-blocking. Bottom-right corner. Auto-dismiss after 4 seconds. Types: success (green left border), error (red left border), info (blue left border). Never use toasts for critical errors — those get inline error messages at the point of failure.

**Instant navigation.** Use Next.js `<Link>` with prefetching for all internal navigation. Page transitions should feel instant. Data fetching uses SWR or React Query with stale-while-revalidate — show cached data immediately, refresh in background.

---

## 2. Navigation & Layout

### 2.1 App Shell

The app shell is a fixed left sidebar (240px width, collapsible to 64px icon-only mode) plus a content area that fills the remaining viewport width. The sidebar is always visible on desktop. The content area scrolls independently.

```
┌─────────────┬────────────────────────────────────────────────┐
│             │                                                │
│   SIDEBAR   │              CONTENT AREA                      │
│   (240px)   │              (flex-1)                          │
│             │                                                │
│  Logo       │   ┌─ Top Bar ────────────────────────────┐     │
│             │   │ Page Title    Search    Action Button │     │
│  Navigation │   └──────────────────────────────────────┘     │
│  Links      │                                                │
│             │   ┌─ Page Content ───────────────────────┐     │
│             │   │                                      │     │
│             │   │                                      │     │
│             │   │                                      │     │
│             │   │                                      │     │
│             │   └──────────────────────────────────────┘     │
│             │                                                │
│  ─────────  │                                                │
│  User Menu  │                                                │
│             │                                                │
└─────────────┴────────────────────────────────────────────────┘
```

### 2.2 Sidebar

**Background:** `--bg-inset`. **Border-right:** 1px solid `--border-default`.

**Logo area (top):** Medina Ventures logo, 120px wide, centered horizontally, 24px top padding. In collapsed mode, show only the icon mark (the M/V geometric shape).

**Navigation links:** Vertical stack, 8px gap. Each link is full-width, 40px height, 12px left padding, 8px border-radius. Icon (20px, Lucide icon set) + label (14px, weight 400).

| Order | Label | Icon | Route | Badge |
|---|---|---|---|---|
| 1 | Contacts | `Users` | `/contacts` | — |
| 2 | Companies | `Building2` | `/companies` | — |
| 3 | Deals | `Handshake` | `/deals` | — |
| 4 | God Mode | `Sparkles` | `/god-mode` | — |
| 5 | Campaigns | `Mail` | `/campaigns` | — |
| — | *divider* | — | — | — |
| 6 | Admin | `Shield` | `/admin` | Count of unresolved DLQ entries (red dot if > 0) |
| 7 | Imports | `Upload` | `/imports` | — |
| 8 | Settings | `Settings` | `/settings` | — |

**Active state:** Background `--accent-glow`, left 2px border `--accent-magenta`, text `--text-primary`, icon color `--accent-magenta`.

**Hover state:** Background `rgba(255, 255, 255, 0.04)`, text `--text-primary`.

**Default state:** Text `--text-secondary`, icon `--text-muted`.

**Admin link visibility:** Only visible to users with role `owner` or `admin`. For `member` role users, the Admin link is hidden entirely — no disabled state, no "access denied" page, just absent.

**User menu (bottom):** Avatar (32px circle) + full name + role badge. Click opens a popover with: "Settings" link, "Sign out" button, and org name display.

**Collapse toggle:** A small chevron button at the bottom of the sidebar (above user menu) toggles between full (240px) and icon-only (64px) mode. Collapsed state persists in localStorage. Tooltips appear on icon hover in collapsed mode.

### 2.3 Top Bar

Every page has a consistent top bar within the content area. Height: 64px. Padding: 0 32px. Border-bottom: 1px solid `--border-default`. Background: `--bg-root`.

**Left side:** Page title (Instrument Serif, 24px). Optional breadcrumb trail for detail pages (e.g., "Contacts / Acme Corp / Sarah Chen").

**Right side:** Page-specific action buttons (e.g., "Add Contact", "New Session"). On pages with search, a search input (280px wide, magnifying glass icon, placeholder text specific to the page).

### 2.4 User Flow — A Typical Day

This is how a managing partner navigates the platform. The navigation must feel natural for this flow:

1. **Start at Deals.** Scan the pipeline board. See a company in "Due Diligence" stage. Click the company name on the card.
2. **Company detail opens.** Check the Overview tab for the latest valuation and enrichment data. Switch to the News tab — scan recent intelligence from Claude web search. Switch to the Timeline tab — see recent emails and a meeting from yesterday.
3. **Click the meeting** in the timeline. Event detail modal opens showing attendees, transcript link, summary, and action items.
4. **Want more context.** Click "Ask God Mode about this" (button on the event detail modal). This navigates to `/god-mode` with the session pre-scoped to this company. The chat input is pre-populated with "Summarize the meeting with [attendees] on [date]."
5. **God Mode answers.** Read the response. Ask a follow-up: "What concerns did they raise about market timing?" Get a sourced answer.
6. **Check the approval queue.** Navigate to Admin. See 3 pending enrichment updates. Review each — approve two (job title updates with high confidence), reject one (incorrect company association).
7. **Send a follow-up.** Navigate to Campaigns. Create a quick campaign targeted at the contacts from the meeting. Select which team member's Outlook sends it. Preview and send.

Every navigation step in this flow must be ≤2 clicks. Links between entities (contact ↔ company ↔ deal ↔ event ↔ God Mode) must be bidirectional and obvious.

---

## 3. Shared Components

These components are reused across multiple pages. Build them as isolated React components in `frontend/components/`.

### 3.1 DataTable

Used for: contact list, company list, task list, audit log, DLQ entries, campaign recipients, import jobs.

**Props:** `columns` (column definitions with header, accessor, sortable flag, width), `data` (row array), `loading` (boolean), `emptyMessage` (string), `emptyAction` (optional CTA button), `onRowClick` (optional handler), `selectable` (boolean — enables checkboxes), `pagination` (page size, total count, current page, onPageChange).

**Behavior:**

- **Sortable columns:** Click column header to sort ascending. Click again for descending. Click again to clear sort. Active sort column header has a small arrow indicator and `--text-primary` color.
- **Row hover:** Background `--bg-surface-hover`. Cursor `pointer` if `onRowClick` is defined.
- **Selection:** Checkbox in the first column. "Select all" checkbox in the header selects the current page only (not all pages). Selected count appears in a floating action bar at the bottom: "3 selected · Apply Tag · Export · Deselect All".
- **Loading state:** 8 skeleton rows. Each cell shows a gray pulsing bar matching the expected column width. The skeleton layout must match the actual column layout — no generic loading screen.
- **Empty state:** Icon (from Lucide set, 48px, `--text-muted`), message text (`--text-secondary`, 15px), and optional action button (primary style).
- **Pagination:** Bottom-right of table. "Showing 1-50 of 342" text. Previous/Next buttons (secondary style). Page size selector: 25, 50, 100.

### 3.2 FilterPanel

Used for: contacts, companies, tasks, audit log, events.

**Layout:** Vertical stack of filter sections in a fixed-width panel (280px) on the left side of the page. Background: `--bg-inset`. Border-right: 1px solid `--border-default`. Full height of the content area, independently scrollable.

**Each filter section:**
- Section label (12px, uppercase, `--text-muted`, letter-spacing 1px)
- Collapsible — click label to expand/collapse. Default: first 3 sections expanded, rest collapsed.
- Section content: checkboxes, multi-select dropdowns, date range pickers, number inputs, or toggle switches depending on the filter type.

**Filter types:**

- **Checkbox group** (contact type, investment status, deal stage): Vertical list of labeled checkboxes. Checking a box immediately updates the data table — no "Apply" button needed.
- **Tag multi-select** (tags): Searchable dropdown with checkboxes. Shows selected tags as pills below the dropdown. AND/OR toggle switch between the label and the dropdown.
- **Date range** (last contact, created date): Two date inputs (From / To) with calendar popovers.
- **Number range** (meetings in 30d, valuation): Two number inputs (Min / Max).
- **Search dropdown** (company filter on contacts page): Text input with autocomplete dropdown showing matching companies.
- **Toggle switch** (has overdue follow-up): Single toggle.

**"Clear All" link:** Top-right of the filter panel. Resets all filters. Text style, `--text-secondary`, hover `--text-primary`.

**Active filter count:** Badge next to "Filters" header showing count of active filters. Uses `--accent-magenta` background, white text.

### 3.3 Timeline

Used for: contact detail timeline tab, company detail timeline tab.

**Data source:** `GET /api/contacts/:id/timeline` or `GET /api/companies/:id/timeline` (TRD §11.2). Returns a merged, sorted array of events, conversations, tasks, and documents.

**Layout:** Vertical list with a thin left border line (1px, `--border-default`). Each entry has a type icon on the left border, timestamp, title, and preview.

**Entry types and their icons:**

| Type | Icon | Color | Preview Content |
|---|---|---|---|
| Meeting | `Calendar` | `--accent-purple` | Attendees, duration |
| Email (inbound) — participant | `MailOpen` | `--info` | From name, subject, first 100 chars of body |
| Email (outbound) — participant | `Send` | `--text-muted` | To name, subject, first 100 chars of body |
| Email — non-participant | `Lock` | `--text-muted` | From name, subject, date only. No body preview. |
| Slack message | `Hash` | `--warning` | Channel name, first 100 chars |
| Task | `CheckSquare` | `--success` if completed, `--warning` if pending | Title, assignee, due date |
| Document | `FileText` | `--text-secondary` | File name, type badge, upload date |

> **Email Privacy in Timelines (v3.0):** Each email entry in the timeline includes a `canReadContent` boolean from the API (TRD §11.2). This flag is computed server-side using `canReadEmailContent()` — it checks whether the requesting user was a from/to/cc participant in the email, or has `owner` role. The frontend NEVER requests or renders email body content when `canReadContent` is `false`.

**Interaction:**

**For entries where `canReadContent` is `true` (or non-email entries):**
- Click to expand inline — shows full preview (email body preview, meeting summary, task description).
- Click "View Full" to navigate to the source entity's detail page or open a modal.
- Click "Open in God Mode" to navigate to `/god-mode` with the entity pre-scoped. This button appears on meeting and email entries.

**For email entries where `canReadContent` is `false`:**
- Entry shows: `Lock` icon (12px, `--text-muted`), subject line, "From: [name] → To: [names]", date. No body preview text.
- Entry is NOT expandable — clicking does nothing. No hover pointer cursor.
- No "View Full" link. No "Open in God Mode" button.
- Below the subject line, show: "You are not a participant in this email" (12px, `--text-muted`, italic).
- The entry is visually subdued: text at 60% opacity, border-left color `--border-default` instead of `--info`/`--text-muted`.

**Filter bar:** Above the timeline. Horizontal pill toggles: All, Emails, Meetings, Tasks, Documents. Default: All. Active pill has gradient background. Inactive pills have `--bg-surface` background with `--border-default` border.

**Loading state:** 5 skeleton entries matching the entry layout.

**Empty state:** "No activity yet" with relevant CTA (e.g., "Connect Outlook to start syncing" if no conversations exist).

### 3.4 EntityHeader

Used for: contact detail, company detail.

**Layout:** Full-width header area at the top of the detail page. Height: auto (content-driven). Background: `--bg-surface`. Bottom border: 1px solid `--border-default`. Padding: 24px 32px.

**Content (left-aligned, horizontal layout):**
- Avatar/Logo (64px circle for contacts, 48px rounded square for companies). Fallback: initials on gradient background.
- Name (Instrument Serif, 28px)
- Subtitle line: Job title + company name (linked) for contacts. Sector + stage badge for companies.
- Type badge and relationship status badge (pill style, `--bg-elevated` background, 12px text).

**Content (right-aligned):**
- Primary action button (e.g., "Enrich Now" — secondary style)
- Overflow menu (three-dot icon → dropdown): Edit, Merge, Delete, Export.

### 3.5 StatRow

Used for: contact detail, company detail, campaign detail.

**Layout:** Horizontal row of stat cards directly below the EntityHeader. Each stat card: min-width 140px, padding 16px, `--bg-surface` background, 1px border bottom `--border-default`.

**Each stat:**
- Value (DM Sans, 24px, weight 500, `--text-primary`)
- Label (12px, `--text-muted`, uppercase)

Numbers use compact formatting: 1,234 not 1234. Currency with symbol: $50M not $50,000,000. Dates as relative when recent: "3 days ago" not "2025-04-08".

### 3.6 TabBar

Used for: contact detail tabs, company detail tabs, admin dashboard tabs, settings tabs.

**Layout:** Horizontal tab bar, full width, border-bottom 1px `--border-default`. Each tab: padding 12px 20px, 14px text, weight 400.

**Active tab:** Text `--text-primary`, bottom 2px border with gradient (`--gradient`).
**Inactive tab:** Text `--text-secondary`. Hover: text `--text-primary`.

Tab content renders below the tab bar with 24px top padding. Tab switches do NOT trigger navigation — they're client-side state. The URL does not change when switching tabs (exception: if deep-linking is needed, use hash fragments like `/contacts/abc#timeline`).

### 3.7 Modal

Used for: event detail, merge contacts, compose email, edit entity, confirm destructive actions.

**Overlay:** `rgba(0, 0, 0, 0.6)` with backdrop blur (4px). Click outside to close (except for destructive confirmation modals).

**Container:** `--bg-elevated` background. 16px border-radius. Max-width: 640px (standard) or 900px (wide — for event detail with transcript). Max-height: 85vh, internally scrollable. Centered on screen.

**Header:** Title (18px, weight 500), optional subtitle, close button (X icon, top-right).

**Footer:** Right-aligned buttons. Primary action on the right, cancel on the left. For destructive actions, the primary button is destructive style (red), and the action name is explicit: "Delete Contact" not "Delete", "Discard Entry" not "Discard".

### 3.8 Toast

**Position:** Bottom-right corner, 24px from edges. Stack upward (newest on bottom).

**Size:** Max-width 380px. Padding: 14px 18px.

**Anatomy:** Left color bar (4px wide, full height — green/red/blue/yellow by type). Message text (14px, `--text-primary`). Optional "Undo" link for reversible actions. Dismiss X button.

**Auto-dismiss:** 4 seconds for success/info. 8 seconds for error. Hover pauses the timer.

### 3.9 CommandPalette (Global Search)

**Trigger:** `Cmd+K` (Mac) / `Ctrl+K` (Windows). Also clickable from a persistent search icon in the top-right of the sidebar.

**Appearance:** Centered modal, 560px wide. Search input at top (auto-focused, 18px text). Results below in sections.

**Result sections:** "Contacts" (name, email, company), "Companies" (name, sector, stage), "Deals" (title, company, stage), "Recent Sessions" (God Mode session titles). Each section shows top 3 results. Results update as the user types (debounced 200ms).

**Actions:** Arrow keys navigate results. Enter opens the selected result. Esc closes the palette.

**Data source:** `GET /api/contacts?keyword=...` + `GET /api/companies?keyword=...` + `GET /api/deals?keyword=...` in parallel (limit 3 each).

---

## 4. Contacts

### 4.1 Contact List — `/contacts`

**User intent:** "I want to find specific contacts or browse my network filtered by tags, type, company, or engagement level."

**Layout:**

```
┌──────────────┬──────────────────────────────────────────────┐
│              │  Top Bar: "Contacts" title                   │
│   Filter     │  Search input    "Add Contact" button        │
│   Panel      │  ─────────────────────────────────────────── │
│   (280px)    │                                              │
│              │  Contact count: "342 contacts"               │
│  Contact     │                                              │
│  Type ▾      │  ┌────────────────────────────────────────┐  │
│  Tags ▾      │  │ □  Name         Company    Type  Tags  │  │
│  Company ▾   │  │ □  Sarah Chen   Acme Corp  LP    ●●    │  │
│  Status ▾    │  │ □  Mike Ruiz   Portfolio   Adv   ●     │  │
│  Engagement  │  │ □  ...         ...        ...   ...    │  │
│  Sector ▾    │  │                                        │  │
│  Follow-up   │  │  [Showing 1-50 of 342]    < 1 2 3 >   │  │
│              │  └────────────────────────────────────────┘  │
│  Clear All   │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

**Table columns:**

| Column | Width | Content | Sortable |
|---|---|---|---|
| Checkbox | 40px | Selection checkbox | No |
| Name | 220px | Avatar (32px) + full name. Merged contacts show a small "→" icon | Yes |
| Company | 180px | Company name (linked to company detail) | Yes |
| Type | 100px | Contact type badge | Yes |
| Tags | 180px | Up to 3 tag pills, +N overflow count | No |
| Last Contact | 120px | Relative date ("3d ago", "2w ago"). Red text if >30 days | Yes |
| Interactions | 90px | Total count | Yes |
| Follow-up | 120px | Date or "—". Red text + "Overdue" if past due | Yes |

**Data source:** `GET /api/contacts` with query params from active filters (TRD §5.1, §11.1 ContactFilter).

**Search:** The top-bar search input sends `keyword` param. Searches across `full_name`, `email`, and `company_name` (server-side). Debounce: 300ms.

**Row click:** Navigates to `/contacts/:id`.

**Bulk actions bar (appears when ≥1 row selected):**
- "Apply Tag" → dropdown of existing tags with search
- "Remove Tag" → dropdown of tags applied to ALL selected contacts
- "Export CSV" → downloads a CSV of selected contacts

**Empty state:** If zero contacts and no filters active: large icon (`Users`), "No contacts yet", "Add your first contact manually or connect Outlook to start syncing." Two buttons: "Add Contact" (primary), "Connect Outlook" (secondary → navigates to Settings → Integrations).

If zero contacts with filters active: "No contacts match your filters" + "Clear filters" link.

### 4.2 Contact Detail — `/contacts/:id`

**User intent:** "I want to see everything about this person — their profile, our interaction history, who they're connected to, and any documents related to them."

**Layout (top to bottom):**

1. **EntityHeader** (§3.4): Avatar, name, job title, company (linked), type badge, relationship status. Actions: "Enrich Now" (secondary), overflow menu (Edit, Merge, Delete).

2. **StatRow** (§3.5): Total Interactions | Meetings (30d) | Email Frequency | Last Contact | Next Follow-up.

3. **TabBar** (§3.6) with tabs:

**Overview Tab (default):**
- Two-column layout (60/40 split).
- Left column: Bio Summary (card, multi-line text), Topics of Interest (tag pills, editable), Pain Points (tag pills, editable), Investment Thesis Tags (tag pills, editable), Custom Fields (key-value list, "Add Field" button).
- Right column: Contact Details card (email, phone, LinkedIn, Twitter — each with copy button and external link icon), Source & Confidence card (source badge, confidence bar, enrichment last run date, "Enrich Now" button), Financial Details card (investment amount, fund commitment, currency — for LP contacts only, hidden if no financial data).
- **Enrichment confidence bar:** Horizontal bar, 0-100%. Below 50%: `--warning`. 50-80%: `--info`. Above 80%: `--success`. Shows as a thin bar (4px height) with percentage text to the right.

**Timeline Tab:**
- Timeline component (§3.3). Data source: `GET /api/contacts/:id/timeline` (TRD §11.2).

**Associations Tab:**
- List of associated contacts from `contact_associations` (TRD §3.5).
- Each row: Avatar + name (linked), relationship type badge (`co-meeting`, `co-email`, `colleague`, etc.), confidence bar, "inferred from" source text.
- "Add Association" button (secondary) — opens modal with contact search to manually link.
- Empty state: "No associations discovered yet. They'll appear automatically as shared meetings and emails are synced."

**Documents Tab:**
- DataTable of linked documents. Columns: Title, Type (badge), Uploaded By, Date, Size.
- Row click: opens a modal with document preview (for text-based) or shows a download button (signed R2 URL).
- "Upload Document" button — opens file upload with contact pre-linked.

**Deals Tab:**
- DataTable of deals linked via company. Columns: Title, Stage (badge), Amount, Probability, Expected Close.
- Row click: navigates to deal detail or opens modal.
- Only visible if the contact has a company with deals.

**404 handling:** If the contact ID doesn't exist, show a full-page message: "Contact not found" with a "Back to Contacts" link. Do not show a broken detail page.

**Merge flow:** Clicking "Merge" in the overflow menu opens a modal:
1. Search for the target contact (the one to merge INTO).
2. Side-by-side comparison: shows both contacts' names, emails, companies, and interaction counts.
3. "Merge" button (destructive style). Confirmation text: "This will merge [discard name] into [keep name]. All their emails, meetings, tasks, and tags will be reassigned. This cannot be undone."
4. During merge: button shows spinner + "Merging..." text. Disable all other actions.
5. After merge: toast "Contacts merged successfully." Redirect to the surviving contact's detail page.
6. If blocked by active campaign: modal shows error inline — "Cannot merge: [discard name] is a recipient in an active campaign. Wait for the campaign to complete or cancel it."

---

## 5. Companies

### 5.1 Company List — `/companies`

Same pattern as contact list. Key differences:

**Filter sections:** Company Type, Investment Status, Stage, Sector, Tags (with AND/OR).

**Table columns:** Logo + Name (220px), Type (badge), Stage (badge), Investment Status (badge), Valuation (formatted currency), News Score (bar + number), Last Enriched (relative date).

**Data source:** `GET /api/companies` with CompanyFilter params (TRD §11.3).

**Row click:** Navigates to `/companies/:id`.

### 5.2 Company Detail — `/companies/:id`

**EntityHeader:** Logo (48px square, rounded-lg), company name, website (linked, opens new tab), sector, stage badge, investment status badge. Actions: "Enrich Now", overflow (Edit, Delete).

**StatRow:** Investment Amount | Ownership % | Current Valuation | Contacts | Deals | News Score.

**Tabs:**

**Overview Tab:** Description card, financial details card (investment amount, date, ownership, valuation, currency), enrichment data card (LinkedIn URL with link, last enrichment date, confidence bar), custom fields.

**Contacts Tab:** DataTable of contacts at this company (filter `company_id`). Row click navigates to contact detail.

**Deals Tab:** DataTable of deals linked to this company. Same columns as deal pipeline cards but in table format.

**Timeline Tab:** Timeline component aggregating events and conversations linked to this company (via contacts' company_id).

**News Tab:** Vertical feed of news articles sourced from Claude web search (TRD §6.5). Each article card: title, source name, published date, summary (2 sentences). Data source: `GET /api/companies/:id/news` (TRD §5.1) + `last_news_summary` field on the company record. If no news: "No recent news for [company name]. News monitoring syncs automatically when enabled in Settings."

**Documents Tab:** Same pattern as contact documents, filtered by `company_id`.

---

## 6. Deals

### 6.1 Deal Pipeline — `/deals`

**User intent:** "I want to see my entire deal pipeline at a glance and move deals between stages by dragging them."

**Layout:** Full-width kanban board. Horizontal scroll if columns exceed viewport width.

**Columns:** One per stage defined in TRD §3.9: Prospect, First Contact, Meeting Scheduled, Due Diligence, Term Sheet, Closing, Closed Won, Closed Lost. Column header shows stage name and deal count. The last two columns (Closed Won / Closed Lost) are visually separated with a thicker left border to signal finality.

**Deal card:**
- Background: `--bg-surface`. Border: 1px `--border-default`. Border-radius: 10px. Padding: 16px.
- Company name (15px, weight 500, linked to company detail).
- Deal title (13px, `--text-secondary`).
- Amount + currency (14px, weight 500) if set. Hidden if null.
- Probability as a small gradient bar (30px wide, 3px height) with percentage text.
- Owner avatar (24px circle) bottom-right.
- Hover: border `--border-hover`, subtle lift (translateY -1px, shadow).

**Drag and drop:**
- Drag handle: entire card is draggable (cursor: grab → grabbing).
- Drop target: column background transitions to `--accent-glow` when a card hovers over it.
- On drop: **optimistic update** — card moves immediately. API call `PATCH /api/deals/:id` with new `stage`. If fails, card snaps back with error toast.
- Stage change triggers audit log (TRD §3.26). The API handles this — the frontend doesn't need to send audit data.

**Filters (top bar):**
- Owner dropdown: filter deals by assigned owner. Shows team member avatars + names.
- Amount range: min/max number inputs.
- "Clear Filters" link when any filter is active.

**"Add Deal" button (primary):** Opens a modal with fields: Title, Company (search dropdown, required), Stage (dropdown, default "Prospect"), Amount, Currency, Probability, Expected Close (date picker), Owner (dropdown), Notes (textarea). "Create Deal" button. On success: deal card appears in the appropriate column with a brief highlight animation (gradient border flash, 1 second).

**Empty board:** If zero deals: "Your deal pipeline is empty." + "Add Deal" button. No empty columns — all stage columns remain visible even if empty, so the pipeline structure is always clear.

**Card click:** Opens a deal detail modal (not a full page — deals are lightweight entities). Modal shows all deal fields in editable form, linked company and contacts, notes with markdown support, and a mini-timeline of stage changes from the audit log.

---

## 7. God Mode

### 7.1 God Mode — `/god-mode`

**User intent:** "I want to ask questions about my firm's data and get AI-powered answers with source citations."

This is the most interaction-heavy page in the platform. The UX must feel as responsive as a native chat app.

**Layout:**

```
┌───────────────┬──────────────────────────────────────────────┐
│               │  Top Bar: "God Mode" title                   │
│   Sessions    │  Scoping chip (if entity-scoped)             │
│   Sidebar     ├──────────────────────────────────────────────┤
│   (300px)     │                                              │
│               │                                              │
│  "New" btn    │           Chat Messages                      │
│               │           (scrollable)                       │
│  ┌──────────┐ │                                              │
│  │ Session 1│ │  ┌────────────────────────────────────┐      │
│  │ 2h ago   │ │  │ User: What did Sarah say about...  │      │
│  ├──────────┤ │  └────────────────────────────────────┘      │
│  │ Session 2│ │  ┌────────────────────────────────────┐      │
│  │ Yesterday│ │  │ Assistant: In the March 15 meeting │      │
│  ├──────────┤ │  │ with Sarah Chen, she mentioned...  │      │
│  │ Session 3│ │  │                                    │      │
│  │ 3d ago   │ │  │ [View Sources]                     │      │
│  └──────────┘ │  └────────────────────────────────────┘      │
│               │                                              │
│               ├──────────────────────────────────────────────┤
│   Search      │  ┌──────────────────────────────────┐  ⬆ 📎 │
│   sessions    │  │  Ask anything about your data...  │  Send │
│               │  └──────────────────────────────────┘       │
└───────────────┴──────────────────────────────────────────────┘
```

### 7.2 Sessions Sidebar

**Background:** `--bg-inset`. Border-right: 1px `--border-default`. Width: 300px.

**"New Session" button:** Full width, secondary style, at the top with 16px padding. Creates a new session and clears the chat area.

**Session list:** Vertical list of past sessions, sorted by `last_activity_at` DESC. Each session item shows:
- Title (14px, weight 400, truncated to 1 line). If no title yet, show "New Session" in italic.
- Last activity relative timestamp (12px, `--text-muted`).
- Turn count (12px, `--text-muted`, e.g., "4 turns").

**Active session:** Background `--bg-surface`, left 2px border `--accent-magenta`.

**Session hover:** Background `--bg-surface-hover`. Right-side shows a delete icon (trash, `--text-muted`) that only appears on hover.

**Delete session:** Click the trash icon → confirmation popover: "Delete this session? Messages will be permanently removed." Two buttons: "Delete" (destructive), "Cancel" (ghost). After delete: toast "Session deleted." Load the next most recent session, or show empty state.

**Search:** Text input at the bottom of the sidebar. Searches session titles. Client-side filtering of the loaded session list. Shows "No sessions match" if no results.

**Data source:** `GET /api/agent/sessions` (TRD §5.1). Load on mount. Paginate if >50 sessions (lazy-load on scroll).

### 7.3 Chat Area

**Empty state (new session, no messages):**

Center of the chat area shows the Medina Ventures logo mark (64px, muted opacity 30%), the text "Ask anything about your firm's data" (18px, `--text-secondary`), and a grid of 4 prompt suggestions in cards (2×2 grid):

```
┌──────────────────────────┐  ┌──────────────────────────┐
│ "Summarize my meetings   │  │ "Which portfolio cos     │
│  from this week"         │  │  raised concerns last    │
│                          │  │  quarter?"               │
└──────────────────────────┘  └──────────────────────────┘
┌──────────────────────────┐  ┌──────────────────────────┐
│ "Who haven't I spoken    │  │ "What's the latest on    │
│  to in 30+ days?"        │  │  our Series B pipeline?" │
└──────────────────────────┘  └──────────────────────────┘
```

Each suggestion card: `--bg-surface` background, 1px `--border-default` border, 14px text, `--text-secondary`. Hover: `--bg-surface-hover`, `--text-primary`. Click: populates the input field and auto-submits.

**Message rendering:**

- **User messages:** Right-aligned. Background: `--bg-surface`. Border-radius: 12px 12px 0 12px. Max-width: 75% of chat area. Padding: 14px 18px.
- **Assistant messages:** Left-aligned. Background: transparent (no bubble — just text flowing). Max-width: 85% of chat area. Markdown rendering with proper heading, paragraph, list, and code block styling.
- **Attachments:** If the user uploaded a file, show a file pill below their message: file icon + filename + size. Clickable to download.

**Streaming response:**

When the assistant is responding, text appears incrementally (via SSE from `POST /api/agent/query`). Show a small gradient pulsing dot (3 dots animation pattern) before the first token arrives. As tokens stream in, render them immediately. The chat area auto-scrolls to the bottom during streaming — but if the user manually scrolls up during streaming, stop auto-scrolling (they want to read earlier content).

After streaming completes:

- A small "View Sources" link appears below the response (12px, `--text-secondary`). Click expands a collapsible section showing the retrieved chunks: source type icon, source date, and a 100-char preview of each chunk. This gives the user transparency into what data informed the answer.
- If the re-ranker was used, show "(AI-ranked)" next to "View Sources". If it fell back to cosine, show "(relevance-ranked)". This distinction is purely informational.

> **Email Privacy in God Mode (v3.0):** The RAG pipeline's post-retrieval filter (TRD §8.2) enforces email privacy server-side — email chunks from conversations where the user is NOT a participant are excluded before they reach Claude's context or the source list. The frontend does NOT need to filter sources. If an email source appears in the "View Sources" list, the user is guaranteed to be a participant (or has `owner` role). This means two users asking the same question may see different source lists and get different answers — this is intentional.

**Source expansion:**

```
▼ View Sources (8 chunks retrieved)

  📧 Email · Mar 15, 2025 · "Sarah mentioned that the valuation discussions..."
  📅 Meeting · Mar 12, 2025 · "[Sarah Chen | Acme Corp]: I think the timing..."
  📄 Document · Feb 28, 2025 · "Series B Term Sheet Draft — Key terms include..."
  📰 News (external) · Mar 10, 2025 · "Acme Corp announces expansion into..."
```

Each source row is clickable — navigates to the source entity's detail page (opens in a new tab to preserve the God Mode session). For email sources, clicking navigates to the conversation detail — the `canReadContent` check there will always be `true` since the user was verified as a participant by the RAG filter.

### 7.4 Input Area

**Layout:** Fixed at the bottom of the chat area. Background: `--bg-root`. Border-top: 1px `--border-default`. Padding: 16px 24px.

**Text input:** Multi-line textarea that auto-grows (1 line → up to 6 lines). Placeholder: "Ask anything about your data..." (when not scoped) or "Ask about [Entity Name]..." (when scoped). Background: `--bg-input`. Border: 1px `--border-default`. Focus: border `--border-active` with glow ring.

**Send button:** Right side of the input. Gradient background (`--gradient`). Icon: `ArrowUp` (Lucide). Disabled (grayed out) when input is empty or response is streaming.

**File upload button:** Left of the send button. Icon: `Paperclip`. Click opens native file picker (accept: `.pdf`, `.docx`, `.csv`, `.txt`, `.md`, `.xlsx`). Drag-and-drop also supported — dropping a file onto the chat area highlights the input zone with a gradient dashed border.

After file selection: file pill appears above the input field showing filename + size + X to remove. The file is attached to the next message sent. Multiple files NOT supported per message — one file at a time.

**Keyboard shortcuts:**
- `Enter` — send message (when input is not empty)
- `Shift+Enter` — new line in input
- `Escape` — cancel file attachment

### 7.5 Entity Scoping

When navigating to God Mode from a contact or company detail page (via "Ask God Mode" buttons on timeline entries or the entity header), the session is created with `context_entity_type` and `context_entity_id` set.

**Scoping chip:** Appears in the top bar, right of the title. Pill shape: gradient border, `--bg-surface` background. Shows "[Entity icon] [Entity Name]" with an X button to clear. Clearing the scope removes the entity filter from RAG queries — the session continues but subsequent queries are unscoped.

**Pre-populated query:** When entering God Mode from a specific event (e.g., clicking "Ask God Mode" on a meeting entry), the input field is pre-populated with a contextual starter: "Summarize the meeting with [attendees] on [date]". The user can edit before sending or send as-is.

### 7.6 Error Handling

- **SSE connection drops mid-stream:** Show the partial response with a warning bar below it: "Response was interrupted. [Retry]" (retry link re-sends the same query).
- **Claude rate limited:** Inline message in the chat: "The AI is currently busy. Please try again in a moment." Style: `--bg-surface` background, `--warning` left border, 14px text.
- **File extraction fails:** Toast: "Could not read [filename]. Supported formats: PDF, DOCX, CSV, TXT." The message is sent without the file attachment.
- **Session load fails:** "Could not load this session. [Try Again] or [Start New Session]."

---

## 8. Email Campaigns

### 8.1 Campaign List — `/campaigns`

**Layout:** DataTable with columns: Title, Status (badge), Recipients, Sent, Failed, Created Date.

**Status badges:**
- Draft: `--text-muted` text, `--bg-elevated` background
- Scheduled: `--warning` text, `--warning` border
- Sending: `--accent-magenta` text, pulsing dot animation
- Sent: `--success` text
- Failed: `--error` text
- Cancelled: `--text-muted` text, strikethrough

**Row click:** Navigates to `/campaigns/:id`.

**"Create Campaign" button (primary):** Navigates to `/campaigns/new`.

### 8.2 Campaign Builder — `/campaigns/new` and `/campaigns/:id` (when draft)

**Layout:** Two-column (60/40 split).

**Left column — Content:**
- Subject line input (full width, 16px text).
- Body template editor — multi-line textarea with toolbar above it. Toolbar buttons: Bold, Italic, Link, and a "Merge Variables" dropdown that inserts `{{full_name}}`, `{{first_name}}`, `{{company_name}}`, `{{job_title}}` at the cursor position. Live preview of variable insertion — highlight `{{variables}}` in gradient text so they're visually distinct from static content.
- Preview pane toggle — shows the email body with a sample contact's data merged in. Uses the first contact from the recipient list for preview.

**Right column — Recipients, Sender & Schedule:**
- **Send As:** Dropdown selector showing team members with connected Outlook accounts. Each option shows avatar + name + email. **Required field** — campaign cannot be sent without selecting a sender. Only users with a valid Outlook token are shown. If no users have connected Outlook: "No Outlook accounts connected. [Connect in Settings]" link.
- **Recipient builder:** Reuses the FilterPanel component (§3.2) with all ContactFilter options. Below the filters: "Matching contacts: N" count (updates dynamically as filters change). "Preview Recipients" link opens a modal showing the first 20 matching contacts with name, email, and company.
- **Schedule:** Radio group: "Send Now" or "Schedule". If scheduled, show a date+time picker.
- **"Save Draft"** (secondary) and **"Send Campaign" / "Schedule Campaign"** (primary) buttons at the bottom.

**Send confirmation:** Before sending, show a confirmation modal: "You are about to send this email to [N] contacts from [sender name]'s Outlook account. Emails will appear in their Sent folder." Shows the subject line and first 3 recipient names. "Send Now" (primary) and "Cancel" (ghost) buttons.

> **No delivery tracking:** Microsoft Graph Mail.Send does not provide open/click/bounce webhooks. The campaign detail page shows send status only (pending/sent/failed per recipient). Emails sent via this flow appear in the sender's Outlook Sent folder and will be indexed by the sync engine on the next ingestion cycle, appearing in the relevant contact timelines.

### 8.3 Campaign Detail — `/campaigns/:id`

**Header:** Campaign title, status badge, "Sent by [sender name]" subtitle, created by, sent date.

**Metrics row (StatRow):** Total Recipients | Sent | Failed. Three stats only — no delivery/open/click/bounce metrics.

**Recipients table:** DataTable of all recipients. Columns: Name (linked to contact), Email, Status (badge: pending/sent/failed), Sent At, Error Message (if failed — truncated, click to expand). Sortable. Filterable by status.

---

## 9. Admin Dashboard

### 9.1 Admin Dashboard — `/admin`

**Access:** Only visible to `owner` and `admin` role users. If a `member` navigates to `/admin` directly, redirect to `/contacts` with no error message.

**Layout:** TabBar with 5 tabs.

### 9.2 DLQ Tab

**User intent:** "I want to see what webhook events failed and decide whether to replay or discard them."

**DataTable columns:** Source (badge: Firefly/Slack/Outlook), Event Type, Received At, Failed At (relative), Error Message (truncated to 80 chars), Retry Count.

**Row actions (right side of each row):**
- "View" (ghost button) → opens modal showing the full error message and a formatted JSON view of the webhook payload (fetched from R2 via the `payload_r2_key`). The JSON viewer uses a monospace font with syntax highlighting. Include a "Copy Payload" button.
- "Replay" (secondary button) → confirmation popover: "Re-enqueue this webhook for processing?" On confirm: `POST /api/admin/dlq/:id/replay`. Toast: "Webhook replayed — check back shortly." Row moves to a "replayed" state (grayed out, status text "Replayed").
- "Discard" (ghost, destructive) → confirmation popover: "Discard this entry? The webhook data will be preserved in storage but won't be processed." On confirm: `POST /api/admin/dlq/:id/discard`. Row moves to "discarded" state.

**Filtering:** Toggle between "Unresolved" (default), "Replayed", "Discarded", "All".

**Empty state:** "No failed webhooks. All integrations are healthy." with a green checkmark icon.

### 9.3 Enrichment Status Tab

**Per-source status cards (grid of 2):**

Each card shows:
- Source name + icon (ReverseContact/LinkedIn, Claude Web Search)
- Status: "Active" (green dot) or "Rate Limited" (red dot + "until [time]")
- Consecutive 429 count (if > 0)
- Last successful call (relative date)
- "Clear Rate Limit" button (destructive ghost) — only visible when rate-limited. Clears the KV rate limit key.

### 9.4 Orphan Events Tab

**DataTable:** Events with `reconciliation_status = 'orphaned'`. Columns: Title, Source (badge), Start Time, Attendees (count), Created At, Days Orphaned.

**Row actions:**
- "Link to Outlook" → opens a modal showing candidate Outlook events (matched by time window ±1 hour). User selects the matching event. `POST /api/events/:id/link-outlook`.
- "Promote" → marks as `standalone`. No confirmation needed — this is non-destructive.
- "Delete" → soft delete with confirmation.

### 9.5 Audit Log Tab

**DataTable with filters.**

**Filters (horizontal bar, not sidebar):** Action dropdown (create, update, merge, approve, etc.), Entity Type dropdown, User dropdown, Date range picker.

**Columns:** Timestamp, User (avatar + name), Action (badge), Entity Type, Entity ID (monospace, linked to entity detail), Summary (auto-generated: "Updated contact.job_title from 'VP' to 'SVP'").

**Row expansion:** Click to expand. Shows before/after JSON diff with additions highlighted in green and removals in red. Uses a simple side-by-side or inline diff layout — not a full diff viewer.

**Data source:** `GET /api/audit-log` with filter params. Entries >90 days are automatically fetched from R2 archive (the API handles this transparently — TRD §3.26).

### 9.6 Sync Status Tab

**Cards for each workflow type (Ingestion, Enrichment, Daily Cron):**

Each card shows:
- Workflow name + last run status badge (completed/partial/failed/running)
- Started at / Completed at
- Items processed / Items failed
- Error message (if failed — truncated, click to expand)
- "Running" state: pulsing dot animation + elapsed time counter

**Auto-refresh:** This tab polls `GET /api/sync/status` every 15 seconds when visible. When a workflow transitions from "running" to "completed" or "failed", show a brief highlight animation on the card.

### 9.7 Approval Queue

The approval queue also surfaces as a separate section within the Admin dashboard, but the sidebar badge count draws attention when items are pending.

**DataTable columns:** Entity Type (badge), Entity Name (linked), Change Type, Field, Proposed Value, Source, Confidence (bar), Created At.

> **Email Privacy in Approval Queue (v3.0):** When an enrichment signal was extracted from a private email, the `source_visibility` on the approval queue entry is `'private'`. The Source column and evidence quote behave differently based on whether the reviewing user was a participant in the source email:
>
> **If the reviewer is a participant (or has `owner` role):**
> - Source column: linked text showing "Email from [contact] on [date]" — clickable to open the conversation detail.
> - Expanding the row shows the evidence quote from the email body.
>
> **If the reviewer is NOT a participant:**
> - Source column: unlinked text showing "Private email · [date]". No clickable link. A small `Lock` icon (12px, `--text-muted`) appears next to the text.
> - Expanding the row shows: "Evidence not visible — you are not a participant in the source email." (14px, `--text-muted`, italic). The proposed value and confidence score are still visible — the reviewer can approve or reject based on the confidence score and field context without reading the email content.

**Row actions:**
- "Approve" (primary, small) → optimistic update: row moves to "approved" state. `POST /api/approval-queue/:id/approve`. If 409 (already resolved by another user): revert optimistic update, toast "Already resolved by [user]."
- "Reject" (destructive ghost, small) → same pattern with `POST /api/approval-queue/:id/reject`.

**Bulk actions:** Select multiple pending items → "Approve Selected" (primary) or "Reject Selected" (destructive). Processes individually per item (not atomic batch — TRD §15.2). Shows results: "5 approved, 1 already resolved."

**Filtering:** Toggle: "Pending" (default), "Approved", "Rejected", "Auto-Approved", "All".

---

## 10. Settings

### 10.1 Settings — `/settings`

**Access:** Available to all roles. `owner` and `admin` can modify settings. `member` can view but not change (inputs disabled with tooltip "Only admins can modify settings").

**Layout:** TabBar with 3 tabs.

### 10.2 General Tab

**Organization info section:**
- Org Name (text input, editable by admin)
- Domain (text input, editable by admin — note: changing this affects email direction classification)

**Sync behavior section:**
Form with labeled inputs. Each input has a help text line below it explaining the setting.

| Setting | Input Type | Help Text |
|---|---|---|
| Auto-approve sync | Toggle switch | "When enabled, low-risk changes (new associations, soft field updates) skip the approval queue." |
| Re-ranker enabled | Toggle switch | "Enables AI-powered result ranking in God Mode. Adds ~1-2s latency but improves answer quality." |
| News feed enabled | Toggle switch | "Enables real-time news monitoring for tracked companies via Claude web search." |
| LinkedIn enrichment enabled | Toggle switch | "Enables LinkedIn profile enrichment via ReverseContact." |
| Sync interval (minutes) | Number input (min: 5, max: 60) | "How often the ingestion workflow syncs new emails and calendar events." |
| Max enrichments per cycle | Number input (min: 10, max: 200) | "Maximum number of entities enriched per enrichment workflow run." |
| Outlook backfill (days) | Number input (min: 30, max: 365) | "How far back to sync emails and events when a user first connects Outlook." |

**"Save Changes" button (primary).** Only enabled when changes exist. On save: `PATCH` to the organizations endpoint. Toast: "Settings saved."

### 10.3 Integrations Tab

**Integration cards** (vertical list — each needs enough horizontal space for status details):

**Microsoft Outlook 365:**
```
┌─────────────────────────────────────────────────────────────┐
│  [Icon]  Microsoft Outlook 365                              │
│                                                             │
│  Status: ● Connected (3 users)     [Disconnect]            │
│  Permissions: Mail.Read, Mail.Send, Calendars.Read,        │
│               Contacts.Read, offline_access                │
│  Token health: ✓ All tokens valid                          │
│  Last sync: 12 minutes ago                                  │
│                                                             │
│  Connected users: Alice (healthy), Bob (healthy),           │
│                   Carlos (⚠ 2 refresh failures)            │
└─────────────────────────────────────────────────────────────┘
```

- "Connect Outlook" button (primary) starts OAuth flow → redirects to Microsoft login → callback stores tokens.
- Shows per-user token health. If consecutive failures ≥ 3, show warning icon + "Reconnect" button for that user.
- Note: Outlook is also used for email campaign sending (Mail.Send permission).

**Slack:**
- "Connect Slack" button starts OAuth bot token flow.
- Shows connected status + number of accessible channels.
- Note: Bot must be `/invite`d to each channel to see messages.

**ReverseContact (LinkedIn):**
- API key-based. Show status only (key is stored server-side, never shown in UI).
- Status: "Configured" (green dot) if the env var is present, "Not Configured" (gray dot) if missing.
- Rate limit status from enrichment status data.

**Firefly AI:**
- Webhook-based. Show webhook URL that needs to be configured in the Firefly dashboard.
- Display: "Webhook URL: `https://your-worker.workers.dev/webhooks/firefly`" with a copy button.
- Status: "Receiving webhooks" (green, if recent events with this source exist) or "No webhooks received" (gray).

**Manual Transcript Upload (In-Person Meetings):**
- Not a connected integration — informational card only.
- Text: "For in-person meeting transcripts, upload the file via the Documents page or drag into God Mode."
- Note: "In-person transcription tool under evaluation."

### 10.4 Team Tab

**DataTable:** Columns: Avatar, Name, Email, Role (badge), Status (Active/Inactive), Last Login.

**Role badges:** Owner (gradient background), Admin (outlined, `--accent-purple`), Member (outlined, `--text-muted`).

**Actions per row (overflow menu):**
- "Change Role" → dropdown: Owner, Admin, Member. Requires current user to be Owner.
- "Deactivate" → soft toggle. Deactivated users can't log in but their data (tokens, associations) is preserved.

**"Invite User" button (primary):** Modal with email input + role selector. Sends an invite (implementation depends on auth provider — Cloudflare Access handles this).

---

## 11. Imports

### 11.1 Import Flow — `/imports`

**User intent:** "I want to upload a spreadsheet and get those contacts into my CRM."

This is a multi-step wizard. Each step has a clear progress indicator at the top. The user can go back to previous steps but not skip ahead.

**Progress bar:** Horizontal stepper at the top of the page. 4 steps: Upload → Map Columns → Preview → Processing. Active step has gradient indicator. Completed steps show a checkmark. Future steps are grayed out.

### Step 1: Upload

- Large drop zone (dashed border, `--border-default`, 200px height). "Drop your file here or click to browse." Accepts: `.csv`, `.xlsx`, `.zip`.
- Source type selector: radio buttons for CSV, Excel, Four Degree Export.
- After file selection: show file name + size + checkmark. "Continue" button (primary) enabled.
- On continue: uploads file to R2 via `POST /api/imports` → creates import job → advances to step 2.

### Step 2: Map Columns

**Layout:** Two-column mapping interface.

```
Source Column (from file)         →    CRM Field
──────────────────────────────────────────────────
"Contact Name"                   →    [full_name        ▾]
"Email Address"                  →    [email             ▾]
"Company"                        →    [company_name      ▾]
"Title"                          →    [job_title          ▾]
"Phone Number"                   →    [phone             ▾]
"Notes"                          →    [notes             ▾]
"Random Column"                  →    [Skip (don't import)▾]
```

- Left side shows the source column header from the uploaded file + a sample value from row 1 (as help text).
- Right side is a dropdown of CRM target fields (full_name, email, phone, company_name, job_title, contact_type, relationship_status, linkedin_url, investment_amount, fund_commitment, notes) plus "Skip (don't import)."
- **AI pre-mapping:** On load, the system calls the import mapping endpoint (which uses §16.7 LLM prompt). The AI's suggested mappings pre-populate the dropdowns. A small "✨ AI suggested" label appears on pre-mapped fields. The user can override any mapping.
- "Continue" button submits the mapping via `POST /api/imports/:id/mapping`.

### Step 3: Preview

**DataTable** showing the first 10 rows with the mapped values. Column headers are the CRM field names.

**Row coloring:**
- Green left border: new contact (email doesn't match any existing contact).
- Yellow left border: update to existing contact (email matches).
- Red left border: validation error (e.g., invalid email format, missing required field).
- Gray left border: skipped (duplicate of another row in the file).

**Summary bar above the table:** "10 new contacts, 0 updates, 0 errors, 0 skipped" (counts are for the first 10 rows only — full counts come during processing).

**"Start Import" button (primary):** Confirmation modal: "This will import [total_rows] rows into your CRM. New contacts will be created and existing contacts may be updated. Continue?" On confirm: `POST /api/imports/:id/confirm`. Advance to step 4.

**"Back" button (secondary):** Returns to mapping step without losing the mapping.

### Step 4: Processing

**Progress display:**
- Large progress bar (gradient fill, 8px height, rounded-full). Percentage + absolute counts: "Processing: 147 / 342 (43%)".
- Live counters below: Created: 98 | Updated: 12 | Skipped: 34 | Failed: 3
- Each counter uses the semantic color for its type (green, blue, gray, red).

**The progress updates via polling** `GET /api/imports/:id` every 2 seconds.

**Completion state:**
- Progress bar reaches 100%. Show summary: "Import complete. 298 contacts created, 12 updated, 29 skipped, 3 failed."
- If any failures: "Download Error Log" link (CSV from R2 with per-row error details).
- "View Contacts" button (primary) navigates to `/contacts` with a filter showing recently imported contacts (source = 'import').
- "Import Another" button (secondary) resets the wizard to step 1.

---

## 12. Responsive & Mobile Behavior

The platform is primarily a desktop tool (1280px+ viewport). Tablet and mobile are secondary but functional.

### 12.1 Breakpoints

```
Desktop:  ≥1280px   Full layout. Sidebar expanded.
Tablet:   768-1279px Sidebar collapsed to icon-only by default. Filter panels become slide-over drawers.
Mobile:   <768px     Sidebar becomes a bottom tab bar (5 icons: Contacts, Companies, Deals, God Mode, More).
                     Filter panels become full-screen overlays with "Apply" button.
                     DataTables become card lists (one card per row, stacked vertically).
                     Kanban board scrolls horizontally with one column visible at a time.
                     God Mode: sessions sidebar hidden, accessible via hamburger menu.
```

### 12.2 Critical Mobile Behaviors

- **God Mode must work well on mobile.** The chat interface is the most-used feature on the go. Input area sticks to the bottom. Keyboard should not obscure the input. Messages are full-width.
- **Contact/company detail:** tabs become a horizontal scrollable pill bar. Content stacks vertically.
- **Deal cards:** each card is full-width on mobile. Columns become horizontally scrollable sections with stage labels as sticky headers.

### 12.3 Touch Targets

All interactive elements on mobile must be ≥44px height. This applies to: table rows, nav links, buttons, tag pills, dropdown items, checkboxes.

---

## 13. Keyboard Shortcuts

Keyboard shortcuts provide power-user speed. They are disabled when a text input or textarea is focused.

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + K` | Open command palette (global search) |
| `Cmd/Ctrl + N` | Create new entity (context-dependent: new contact on `/contacts`, new deal on `/deals`, new session on `/god-mode`) |
| `Cmd/Ctrl + /` | Focus God Mode input (from any page — navigates to `/god-mode` if not already there) |
| `Escape` | Close modal / clear search / deselect rows |
| `J` / `K` | Navigate down/up in table rows (when no input is focused) |
| `Enter` | Open selected row / confirm modal |

**Shortcut hint:** Show a small "⌘K" hint in the command palette trigger area. On first visit, show a one-time tooltip: "Tip: Press ⌘K to search anything, ⌘/ to jump to God Mode."

---

*End of Frontend Specification — Version 3.0*
*Companion to TRD v3.0*
*Medina Ventures Intelligence Platform — Confidential*
