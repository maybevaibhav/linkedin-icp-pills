# LinkedIn ICP Pills

> I had one boring task: remembering who I had already reached out to before commenting on their LinkedIn post.
> No existing tool did it. So I built one in a weekend, with AI doing most of the typing.
>
> That is the whole business. I'm **Vai S.** and I help B2B agency owners hand their boring tasks to AI.
> 99% of the time you do not need a custom build like this one. [Here is what you do need.](https://efficialabs.com/ai-boring-task-fix/)

A Chrome extension that shows a small pill under people's names on LinkedIn:

- **ICP** (orange) – the person is a contact in your HubSpot CRM.
- **Your own labels** (any colour) – e.g. "Top authority influencer", added by you.

Pills appear in the feed, on profile pages, under comment authors, in search results and in most other places a person's name links to their profile.

## Install (one time, ~1 minute)

1. Unzip the folder somewhere permanent (e.g. `Documents/linkedin-icp-pills`). Do not delete it later; Chrome loads the extension from this folder.
2. In Chrome open `chrome://extensions`.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and pick the `linkedin-icp-pills` folder.
5. The settings page opens automatically. (You can always reopen it by clicking the orange extension icon in the toolbar. Pin it via the puzzle-piece icon if it is hidden.)

## Connect HubSpot (one time, ~2 minutes)

1. In HubSpot click the **gear icon** (Settings), top right.
2. Left menu: **Integrations → Private Apps → Create a private app**.
3. Name: `LinkedIn ICP Pills`.
4. **Scopes** tab → search `contacts` → tick **crm.objects.contacts.read** and **crm.schemas.contacts.read**. Nothing else (read only).
5. **Create app → Show token → Copy**.
6. Paste the token into the extension settings and click **Test & save**.

The extension then downloads your contact list once and keeps a copy inside Chrome. It refreshes automatically every 7 days by default; you can change the number of days in settings. Click **Sync contacts now** after adding a batch of new people to HubSpot if you want them to show up immediately.

## How matching works

1. **LinkedIn URL** (reliable): the extension reads the LinkedIn URL that Apollo saved on each HubSpot contact and compares it with the profile link on LinkedIn. The settings page auto-detects which HubSpot field holds it.
2. **Name fallback** (less certain): if a HubSpot contact has no LinkedIn URL, the extension matches by full name, but only when exactly one contact has that name. These show as **ICP ?** with a dashed border. You can switch this off in settings.

## Your own labels

- **From LinkedIn:** hover over a name, click the small **+**, type a label, pick a colour, click **Add label**. Same place to remove a label.
  For someone who has no label yet the **+** sits just to the right of their name and takes no extra space, so unlabelled people look exactly as they did before. Once a label exists it appears on its own row under the name.
- **From settings:** paste a LinkedIn profile URL, type the label, click **Add**. The table lists everyone you have labelled. **Edit** on a row lets you change the name, rename labels, change colours, or add and remove labels. Use **Export backup** occasionally so you never lose your list.

## Your activity summary

The extension counts, on your own machine, how many people it flagged for you. Open settings to see the numbers any time.

Every 14 days a small card appears in the bottom corner of LinkedIn with a summary of that period. It never blocks the page, never interrupts you while you are typing a comment, and closes with the ×, the Escape key, or "Not now". If you would rather not see it, click "Stop showing these" on the card, or turn it off in settings. You can also change 14 days to anything from 1 to 90.

If there is almost nothing to report, the card is skipped and waits for the next period, so it never shows you an empty summary.

These counts are stored in your browser and are never sent anywhere, including to me.

## Things to know

- Everything is stored inside Chrome on this computer only. Nothing is sent anywhere except read-only calls to HubSpot.
- LinkedIn changes its page code from time to time. If pills stop appearing in one place (e.g. comments), that part of the extension needs a small selector update. The core (feed, profile) uses several fallbacks.
- The HubSpot token is like a password to read your contacts. Keep it private. You can revoke it any time in HubSpot → Private Apps.


---

## Who built this

I'm **Vai S.**, ex-Accenture, and I run [Efficialabs](https://efficialabs.com/ai-boring-task-fix/).

I help B2B agency owners take one tedious, click-heavy task and end it with AI. Usually that means the tools you already have: Claude, ChatGPT, connectors, plugins, MCP. No code, no vibecoding.

Occasionally no existing tool does the job. This extension is one of those cases, and this is what the result looks like.

- **One real AI use case a week, free:** [efficialabs.com](https://efficialabs.com/ai-boring-task-fix/#newsletter)
- **Kill one of your boring tasks, $300, once:** [AI Boring-Task Fix](https://efficialabs.com/ai-boring-task-fix/)

MIT licensed. Fork it, rename it, ship it inside your own tool. Tell me what you built.
