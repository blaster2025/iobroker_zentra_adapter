# Deployment

The adapter is developed on Windows but runs on any ioBroker host. The target here is a Linux server. The package contains only compiled JavaScript (`build/`), so it is platform-independent.

Requirements on the ioBroker host:

- Node.js ≥ 22
- js-controller ≥ 6.0.11
- admin ≥ 7.0.23

## Option A: Install from a tarball (no GitHub needed)

1. On the development machine, build the adapter and create the package:

   ```bash
   npm run build
   npm pack            # creates iobroker.zentra-<version>.tgz
   ```

2. Copy the file to the server, e.g. with `scp iobroker.zentra-0.0.1.tgz user@server:/tmp/`.

3. On the server, install the package as the ioBroker user:

   ```bash
   cd /opt/iobroker
   sudo -u iobroker npm install /tmp/iobroker.zentra-0.0.1.tgz --omit=dev
   iobroker upload zentra
   iobroker add zentra        # first install only: creates instance zentra.0
   ```

For an update, repeat steps 1–3 without `iobroker add`, then run `iobroker restart zentra.0`.

## Option B: Install from GitHub

`build/` is committed to git so that the adapter can be installed directly from the repository:

1. Run `npm run build` before each commit.
2. In the ioBroker admin, go to *Adapters → Install from custom URL* and enter the repository URL. Alternatively, run `iobroker url https://github.com/<account>/ioBroker.zentra` on the server.

## Configuration after installation

1. Open the instance settings of `zentra.0`.
2. Enter the API key. You find it in ZENTRA Cloud under *Profile → Integrations → Show Token*.
3. Click **Save**. The instance must be running for the device list to load.
4. Open **Devices to poll** and select the devices.
5. Click **Save** again.

The states then appear under `zentra.0.<device_id>`. See [Concept.md](Concept.md) for the object tree.

## Local testing with dev-server

The project includes `@iobroker/dev-server`, which runs a local ioBroker instance on the development machine:

```bash
npm run dev-server setup      # once
npm run dev-server watch      # starts ioBroker with admin on http://localhost:8081
```

**Windows 11:** `dev-server watch` crashes with `spawn wmic.exe ENOENT` because nodemon needs `wmic.exe`, which Windows 11 no longer includes. Workaround:

1. Start ioBroker with `npm run dev-server run`.
2. Copy `build/` to `.dev-server/default/node_modules/iobroker.zentra/build/`.
3. In that folder, start the adapter with `node build/main.js --force --logs`.

To change the instance configuration, use the CLI in `.dev-server/default`:

```bash
node node_modules/iobroker.js-controller/iobroker.js object set system.adapter.zentra.0 native.apiKey=<key>
```

The CLI encrypts `encryptedNative` fields. `.dev-server/` is ignored by git. Still, clear the key after testing.
