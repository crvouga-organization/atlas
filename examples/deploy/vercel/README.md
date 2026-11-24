# Atlas on Vercel

A static viewer served by the Vercel CDN and an Atlas API function, with results in a private Vercel Blob store. There is no
container, bucket or proxy to run, and CI publishes with no secret.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcrvouga%2Fatlas%2Ftree%2Fmain%2Fexamples%2Fdeploy%2Fvercel&project-name=atlas&repository-name=atlas&env=ATLAS_TOKEN,ATLAS_READ_TOKEN&envDescription=Two%20long%20random%20strings%20(openssl%20rand%20-hex%2024)%3A%20the%20admin%20token%2C%20and%20the%20token%20people%20sign%20in%20with%20to%20look%20at%20results&envLink=https%3A%2F%2Fgithub.com%2Fcrvouga%2Fatlas%2Fblob%2Fmain%2Fdocs%2Fdeploying.md%23vercel&stores=%5B%7B%22type%22%3A%22blob%22%7D%5D)

## 1. Deploy

Click the button. Vercel copies this folder into a new repository of yours, asks for two tokens, connects a Blob
store (which sets `BLOB_READ_WRITE_TOKEN`), and deploys. Make each token a long random string: `openssl rand -hex 24`.

- `ATLAS_TOKEN` is the admin token: settings, and garbage collection at `/admin`.
- `ATLAS_READ_TOKEN` is for people who look. The browser asks for it: any user name, the token as the password. To let
  anyone with the URL look instead, set `ATLAS_ANONYMOUS_READ=1`.

The Blob store must be **private**. If Vercel made a public one, the first upload says so; create a private store under
Storage, connect it to the project, and redeploy.

Open the deployment's URL. Until something is published it shows an empty report; if something is missing, the page
names the variable to set.

## 2. Publish from CI, with no secret

Every repository owned by the GitHub account or organization this project was deployed into may publish. Its GitHub
Actions jobs prove which repository they are with a signed OIDC token, so there is no token to create, copy or rotate.
Give the job `id-token: write` and the server's URL:

```yaml
permissions:
  contents: read
  id-token: write          # the job's identity is its credential
env:
  ATLAS_STORE: https://atlas-your-team.vercel.app
steps:
  - run: npx atlas report publish --producer unit --junit out.xml --environment web
  - run: npx atlas report status --branch "${GITHUB_HEAD_REF:-$GITHUB_REF_NAME}" --branch main
```

To trust other owners, only some repositories, or only one branch, set `ATLAS_TRUSTED_PUBLISHERS` (for example
`github:acme,github:partner/web@refs/heads/main`). Pull requests from forks get no identity token, so they cannot
publish. A laptop, or CI elsewhere, publishes with a publish token instead: set `ATLAS_PUBLISH_TOKEN` in the project and
`ATLAS_TOKEN` on the machine.

Large files (recordings, traces) go straight to the Blob store with a one-time upload token, since a Vercel function
accepts at most about 4.5 MB per request. The server checks each file after it arrives, the same way it checks any
upload.

## 3. Updates

New Atlas releases arrive as Dependabot pull requests. `.github/workflows/update.yml` merges minor and patch releases,
and Vercel redeploys on the merge. A major release, which may need changes, waits for you. Upgrading by hand is the same
thing: bump `@crvouga/atlas` in `package.json`.

## Notes

- **Sign-in.** Enable Vercel Authentication to protect the viewer and API together. When protection is enabled, CI
  needs the deployment bypass secret (`ATLAS_HEADERS='x-vercel-protection-bypass=…'`). Atlas's own tokens decide
  who may look.
- **Garbage collection** uses the deployment policy, or the saved policy when one exists. It is off by default. The daily `/api/cron` run applies it once `CRON_SECRET` is set
  in the project; Vercel Cron sends it. Save the policy at `/admin` with the admin token: the build prebuilds that page.
- **Live updates** come over a stream that the server ends every 4 minutes, before Vercel's time limit; the viewer
  reconnects on its own.

See [docs/deploying.md](https://github.com/crvouga/atlas/blob/main/docs/deploying.md#vercel) for the details.
