# detoilo Zalo desktop connector

Shop-PC host for unofficial **personal Zalo** ([zca-js](https://www.npmjs.com/package/zca-js)).
Owners keep the session on a computer at the shop. The app **dials out** to
[`detoilo-be`](https://github.com/pt-pro-ai/detoilo-be) over WebSocket — no public
IP or inbound port on the shop network.

This repository is the **release source** for Windows/macOS installers. Pairing
APIs stay in `detoilo-be`. The HTTP sidecar here is for local API development
only; do not expose `:8091` to the internet.

> **Experiment:** Personal Zalo is not an official Zalo API. Review
> [Zalo Điều khoản sử dụng](https://zalo.vn/dieukhoan/) §4.7 before enabling.

## Why a separate repo

Installer builds are 100MB+ Electron artifacts with a different cadence than the
Python API. Shipping them from `detoilo-be` blocked backend deploys and mixed
Node/Electron CI into a FastAPI service. Tag this repo to cut a desktop release
without touching the API.

## Owner flow

1. Connect personal Zalo in the owner workspace.
2. Install **detoilo Zalo** on the shop PC and enter the 6-digit pairing code.
3. Scan QR in the workspace as before.
4. Leave the app running during open hours.

## Develop

```bash
npm install
export DETOILO_PUBLIC_BASE_URL=http://127.0.0.1:8000
npm test
npm run desktop
```

HTTP sidecar (local API only):

```bash
export DETOILO_ZALO_PERSONAL_BRIDGE_SECRET=detoilo_dev_zalo_personal_bridge
npm start
# listens on 0.0.0.0:8091
```

Backend env when using the sidecar:

```bash
export DETOILO_EXPERIMENT_ZALO_PERSONAL=true
export DETOILO_ZALO_PERSONAL_BRIDGE_URL=http://127.0.0.1:8091
export DETOILO_ZALO_PERSONAL_BRIDGE_SECRET=detoilo_dev_zalo_personal_bridge
export DETOILO_PUBLIC_BASE_URL=http://127.0.0.1:8000
```

## Release

Installers are **large files** (Windows ~125MB, macOS ~300MB). GitHub **rejects
git blobs over 100MB**, so they are never committed. CI uploads them as
[GitHub Release assets](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
(up to 2GB each) with `gh release upload`.

1. Bump `"version"` in `package.json` (and keep the lockfile in sync).
2. Push a tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. GitHub Actions builds Windows (NSIS + zip) and macOS (dmg + zip), stores the
   binaries as uncompressed workflow artifacts, then streams each file onto the
   GitHub Release.

Local upload after `npm run dist:win` / `dist:mac`:

```bash
./scripts/upload-release.sh v0.1.0
```

Stable download URLs (latest tag):

| Platform | Asset |
| --- | --- |
| Windows x64 installer | `detoilo-zalo-win-x64.exe` |
| Windows x64 zip | `detoilo-zalo-win-x64.zip` |
| macOS Apple Silicon | `detoilo-zalo-mac-arm64.dmg` |
| macOS Intel | `detoilo-zalo-mac-x64.dmg` |

Point `detoilo-be` at those assets:

```bash
export DETOILO_ZALO_DESKTOP_DOWNLOAD_WINDOWS="https://github.com/pt-pro-ai/detoilo-zalo-connector/releases/latest/download/detoilo-zalo-win-x64.exe"
export DETOILO_ZALO_DESKTOP_DOWNLOAD_MACOS="https://github.com/pt-pro-ai/detoilo-zalo-connector/releases/latest/download/detoilo-zalo-mac-arm64.dmg"
```

Local packaging (run on the target OS for a signed Mac build):

```bash
npm run dist:win   # NSIS + zip
npm run dist:mac   # dmg + zip
```

macOS builds in CI are **unsigned** (`identity: null`). Sign/notarize on a Mac
with an Apple Developer certificate before wide distribution.

## Protocol

The desktop app connects to:

```text
WS {DETOILO_PUBLIC_BASE_URL}/api/v1/bridges/zalo_personal/ws
```

with a pairing `code` or a persisted `device_token`. The API sends RPC methods
(`health`, `qr.start`, `qr.status`, `account.attach`, `account.send`,
`account.detach`) implemented in `core.mjs`. Inbound DMs are POSTed to
`/webhooks/zalo_personal` with `X-Detoilo-Bridge-Signature: sha256=…`.
