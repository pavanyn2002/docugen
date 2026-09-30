# Screenshot walkthroughs

Docugen can import existing screenshots or capture an explicit browser flow and
turn it into a step-by-step Markdown guide. Captions and instructions are supplied
by you; screenshots are not sent to a model.

## Import existing screenshots

Create `account-setup.json` inside your repository:

```json
{
  "schemaVersion": 1,
  "id": "account-setup",
  "title": "Set up an account",
  "summary": "Create a profile and save its settings.",
  "steps": [
    {
      "title": "Open profile settings",
      "instruction": "Choose Profile from the account menu.",
      "screenshot": "screenshots/profile.png",
      "alt": "Profile settings form",
      "expected": "The profile form is visible."
    }
  ]
}
```

Screenshot paths are relative to the manifest's directory, must stay inside the
repository, and cannot traverse symlinks. Supported images are PNG, JPEG, and
WebP, up to 15 MiB each. A guide can contain 1–50 ordered steps.

```bash
npx @pavanyn/docugen walkthrough import account-setup.json
npx @pavanyn/docugen walkthrough list
npx @pavanyn/docugen walkthrough show account-setup
```

The generated guide is `docs/generated/walkthroughs/account-setup.md`, linked
from `docs/generated/walkthroughs.md` and the generated README. A configured
`outDir` is respected.

## Capture a browser flow

Browser capture requires optional Playwright in the target repository:

```bash
npm install --save-dev playwright
npx playwright install chromium
```

Import, synchronization, and CI checks do not require a browser. If Chrome or
Edge is already installed, select it with `--channel chrome` or `--channel msedge`.

Create `profile-flow.json`:

```json
{
  "schemaVersion": 1,
  "id": "profile-settings",
  "title": "Update your profile",
  "startUrl": "http://localhost:3000/profile",
  "viewport": { "width": 1280, "height": 720 },
  "maskSelectors": [".account-email"],
  "steps": [
    {
      "title": "Open profile settings",
      "instruction": "Open your profile settings.",
      "alt": "Profile settings before editing"
    },
    {
      "title": "Save the profile",
      "instruction": "Enter a name and choose Save profile.",
      "alt": "Confirmation after saving",
      "expected": "A success message is visible.",
      "actions": [
        { "type": "fill", "selector": "#name", "value": "Demo user" },
        { "type": "click", "selector": "#save" },
        { "type": "wait", "selector": "#success" }
      ]
    }
  ]
}
```

```bash
npx @pavanyn/docugen walkthrough capture profile-flow.json --dry-run
npx @pavanyn/docugen walkthrough capture profile-flow.json
```

Each step performs its actions, then captures a screenshot. Supported actions
are `goto` with an HTTP(S) URL, `click`, `fill`, and `wait` for a visible selector.
Use `"fullPage": true` on a step to capture the full scrollable page. `--headed`
shows the browser while the flow runs.

Capture executes the supplied actions against the application. Use a test
account or development environment for flows that submit forms or change data.
`--dry-run` validates the flow and output ownership without opening a browser.

### Authentication and masking

Use `--storage-state path/to/private-state.json` to load previously exported
Playwright authentication state. Keep that file ignored by Git; Docugen does
not copy it into the guide or save it back to disk.

Use `valueEnv` instead of `value` for sensitive fields:

```json
{ "type": "fill", "selector": "#api-key", "valueEnv": "DEMO_API_KEY" }
```

Password inputs, all fields filled through `valueEnv`, and `maskSelectors` are
masked in every screenshot. Fill values and environment-variable names are not
stored in the walkthrough record. Recorded page URLs omit credentials, query
strings, and fragments. Imported images are copied as supplied: remove sensitive
content from them before import.

## Review and maintain a guide

```bash
npx @pavanyn/docugen walkthrough review profile-settings
npx @pavanyn/docugen sync
npx @pavanyn/docugen check
```

New guides are drafts with unreviewed instructions. Review requires a configured
Git email and records who reviewed the exact text and screenshot hashes.
Screenshots show visible UI state; review does not establish backend behavior
or automatically verify code-inferred requirements.

To change a guide, edit its source manifest or flow and explicitly replace it:

```bash
npx @pavanyn/docugen walkthrough import account-setup.json --update
npx @pavanyn/docugen walkthrough capture profile-flow.json --update
```

An update resets review. `sync` re-renders the recorded snapshot without opening
a browser or taking new screenshots. Missing or changed stored screenshots cause
`check` to fail; restore the exact image or explicitly update and review the guide.

Human records live in `docs/.walkthroughs/<id>.json`. Images are copied into
`docs/.walkthroughs/assets/<id>/` with filenames based on their SHA-256 hashes.
Commit these with the generated guide so source links remain portable. Original
input images and hand-written documentation are preserved. Removing a record
and synchronizing removes its marked generated pages; stored images are retained.
