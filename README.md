# ⚡ SudoDola Studio v2.5 by SudoDotDev - Standalone Desktop Application

A headless, high-concurrency desktop video generation farm built for **[Dola AI](https://www.dola.com)** (ByteDance Seedance 2.5) by **SudoDotDev**. 

**No browser window needed!** Runs 100% in the background, rotates multi-account cookies, enforces a 5-minute safety cooldown per account, and downloads clean, unwatermarked 30-second 1080p MP4 videos directly to your PC.

---

## 🚀 How to Run the Desktop App

You can launch the desktop application directly in two ways:

### Option 1: 1-Click Batch File (Recommended)
Double-click [`run-desktop.bat`](file:///c:/Users/Davie/Programming/DolaExtensionBySudoDotDev/run-desktop.bat) in the project folder.

### Option 2: Terminal / PowerShell
```bash
npm start
```

---

## 🌟 Desktop Features

1. **100% Headless (Zero Browser Windows Open)**:
   - Direct HTTP API networking and background worker concurrency.
   - You can work, play games, or lock your computer while it renders in the background.

2. **Direct Drive Saving**:
   - Saves clean MP4 files directly to your hard drive (defaults to `Videos\SudoDola`).
   - Click **"Browse"** to pick any folder, external SSD, or network drive using the native Windows Explorer dialog.
   - Click **"Open Folder"** to open your destination directory in Windows Explorer.

3. **Session Vault & Multi-Account Pool**:
   - Drag & drop or pick `.json` or `.txt` cookie files exported from Chrome (via Cookie-Editor).
   - Alternatively, drop `.json` cookie files directly into the `accounts/` directory—the app auto-ingests them on startup.
   - Filter accounts by `All`, `Live`, `No Skill`, and `Resting`.
   - Batch health check: click **"Test Selected"** or **"Verify All"** to check session validity against Dola's API.
   - Prune dead accounts with 1 click.

4. **5-Minute Safety Cooldown & 18 Concurrency**:
   - Automatically rests every account for at least 5 minutes between video renders to prevent rate limits and anti-fraud triggers.
   - Scales up to 18 headless workers in parallel across your account pool.

5. **Prompt Studio & Seedance 2.5 30s Integration**:
   - Supports Single Prompt Matrix and Multi-Prompt List modes.
   - Quick art direction injectors: *35mm Cinematic Film*, *Photorealistic 8K*, *Studio Anime*, *Cyberpunk Neon*, *3D CGI Hyper-Detail*.
   - Batch volume stepper with presets (`5`, `10`, `25`, `50`, `100`).
   - Strict 30-second 1080p Seedance 2.5 enforcement.

6. **ByteDance / Doubao Video Stream Decryptor**:
   - Built-in AES-CBC / SHA-512 cryptographic engine (`video-crypto.js`) to decrypt ByteDance `fplay` fallback tokens into direct, unwatermarked MP4 streams.
   - Automatically strips ByteDance TOS watermark templates and queries.

7. **Real-Time Mission Telemetry**:
   - 18 visual worker slots with pulse indicators.
   - Live stream log terminal (`stream.log`) tracking active workers, download sizes, and render times with authentic system clock timestamps.
   - Real-time progress bar and metrics.

---

## 📁 Project Structure

```text
├── main.js                  # Electron main process (native dialogs, window lifecycle, IPC)
├── preload.js               # Context isolation IPC bridge
├── index.html               # SudoDola Command Deck UI (Bento Grid layout)
├── styles.css               # Dark cyber design system
├── renderer.js              # Frontend UI controller and event listeners
├── video-crypto.js          # ByteDance / Doubao AES-CBC stream decryptor
├── SKILL.md                 # Seedance 2.5 30-second execution contract
├── run-desktop.bat          # 1-Click launcher script for Windows
├── package.json             # App manifest & dependencies
├── engine/
│   ├── cookies.js           # Multi-account cookie parsing and vault management
│   ├── dola-api.js          # Direct Dola API client, fallback decryptor & disk streaming
│   └── orchestrator.js      # Multi-worker scheduler and 5-min cooldown rotator
├── accounts/                # Auto-scanned folder for cookie files
└── data/                    # User data and persistent accounts storage
```

---

## ⚡ Engineered by SudoDotDev
Built for high-volume automated video generation on Dola AI.
