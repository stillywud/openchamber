# Building Windows Single EXE

This guide covers how to build the OpenChamber Windows single EXE package locally.

For end users, the packaged bundle now includes two Windows launchers at the bundle root:

- `OpenChamber.vbs` - recommended double-click launcher with no visible console window
- `OpenChamber.cmd` - fallback launcher that is easier to inspect while troubleshooting

## What Is Bundled

The Windows EXE bundles the **OpenChamber web runtime** — the UI, server, and all client-side components needed to run OpenChamber in a browser.

The EXE does **NOT bundle** the OpenCode CLI. OpenCode must be installed separately on the system.

## Packaged Mode Behavior

When running from the packaged EXE, OpenChamber operates in **external-OpenCode mode** by default:

- The packaged app will NOT automatically start an OpenCode server
- Users must point OpenChamber at an external OpenCode server using environment variables or the CLI

### How Users Point OpenChamber at an External OpenCode Server

Users connecting to a packaged OpenChamber EXE have several options:

**Option 1: Environment variables**
```bash
# Connect to OpenCode on default port (4095)
set OPENCODE_SKIP_START=true
openchamber --port 3000

# Or connect to a specific host/port
set OPENCODE_HOST=http://localhost:4095
set OPENCODE_SKIP_START=true
openchamber --port 3000
```

**Option 2: Connect to a remote OpenCode server**
```bash
set OPENCODE_HOST=https://your-opencode-server.com:4095
set OPENCODE_SKIP_START=true
openchamber --port 3000
```

**Option 3: Use the CLI to manage OpenCode separately**
```bash
# Start OpenCode in one terminal
opencode serve

# Start OpenChamber in another terminal, pointing to OpenCode
openchamber serve --foreground
```

### Updates

When a new version is released, users get updates by **replacing the EXE file** — not via `npm update` or package manager upgrades. The packaged distribution is self-contained and doesn't use the npm ecosystem for updates.

## Local Build Prerequisites (for Maintainers)

### Required Tools

- **Bun** (1.3.5 or compatible) - Required for building the web runtime
  - Install via: `curl -fsSL https://bun.sh/install | bash`
  - Or via npm: `npm install -g bun`

- **Node.js** 20+ (optional, only needed if Bun is unavailable)

### Build Commands

```bash
# Full build (stages runtime and creates EXE bundle)
bun run build:windows-exe

# Stage only (prepare files without wrapping into EXE)
bun run build:windows-exe:stage

# Stage and verify (runs integration tests on staged runtime)
bun run build:windows-exe:verify
```

### Output Locations

- **Staged runtime**: `{temp}/openchamber-windows-runtime-stage/`
- **EXE bundle**: `dist/bundles/openchamber-{version}-windows-x64.zip`

After extracting the zip on Windows, users should double-click `OpenChamber.vbs`.

### Environment Variables (Optional)

- `BUN_BINARY` - Path to a specific Bun binary
- `BUN_INSTALL` - Bun installation directory (auto-detects `bun.exe` location)

### Customization Options

```bash
# Stage to custom directory
node scripts/build-windows-exe.mjs --stage-only --output-dir ./my-stage

# Stage without creating EXE bundle
node scripts/build-windows-exe.mjs --stage-only --no-wrap

# Use specific Bun binary
node scripts/build-windows-exe.mjs --bun-binary C:\path\to\bun.exe
```

## Troubleshooting

### "Unable to find Bun or the local Vite CLI"

The build script requires Bun to compile the web runtime. Ensure Bun is installed and accessible in your PATH.

### Build fails with missing dependencies

Run `bun install` in the repository root before building.

### Verification tests fail

The verification step runs a staged runtime and checks:
- Health endpoint responds correctly
- External OpenCode mode is detected properly

If verification fails, check:
- Port availability (test uses random free ports)
- Firewall settings on Windows that might block local connections
