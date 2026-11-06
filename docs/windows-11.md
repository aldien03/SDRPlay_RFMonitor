# Install RF Monitor on Windows 11

**Time:** 20-30 minutes. **Skill needed:** none. You do not need to know Linux, Node.js or programming.

> **Read first.** Windows is for **evaluation and training**. RF Monitor is qualified for **Ubuntu 24.04** only, so a Windows install always shows as *not production-ready*. Use Ubuntu for real monitoring ([Ubuntu guide](ubuntu-24.04.md)).

## What you need

| Item | Notes |
| --- | --- |
| Windows 11 PC | 64-bit, administrator account, 8 GB RAM or more |
| Internet | Only during installation |
| SDRplay RSPdx or RSPdx R2 | With its antenna connected |
| A blue **USB 3** port | Plug straight into the PC. Do not use a USB hub. |

The installer checks and installs the rest for you. These are the **prerequisites** it handles:

| Prerequisite | Who installs it |
| --- | --- |
| Node.js 20 or newer (runs RF Monitor) | Installer, automatically |
| SDRplay API (the receiver driver) | **You**, from sdrplay.com. The installer opens the page and waits. |
| SDRconnect (SDRplay's receiver software) | **You**, from sdrplay.com. The installer opens the page and waits. |

## Step 1 - Download RF Monitor

1. Go to <https://github.com/aldien03/SDRPlay_RFMonitor>.
2. Click the green **Code** button, then **Download ZIP**.
3. Open your **Downloads** folder, right-click the ZIP, choose **Extract All...**, then **Extract**.

Expected result: a folder named `SDRPlay_RFMonitor-main` containing `deploy`, `docs`, `src` and other folders.

## Step 2 - Check the PC (changes nothing)

1. Open the extracted folder, then `deploy`, then `windows`.
2. Click the address bar, type `powershell` and press Enter.
3. Paste this and press Enter:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-rfmonitor.ps1 -CheckOnly
   ```

Expected result: lines starting with **OK** (good), **NOTE** (fine, read it) or **STOP** (must fix). Each STOP line says how to fix it. Missing SDRplay API or SDRconnect will show as STOP at this point; that is normal and step 3 handles it.

## Step 3 - Run the installer

1. In the `windows` folder, **double-click `Install-RFMonitor.bat`**.
2. Windows asks *"Do you want to allow this app to make changes?"* Click **Yes**.
3. Follow the numbered steps on screen. The installer works through 8 steps:

| Step | What happens | What you do |
| --- | --- | --- |
| 1 | Checks Windows 11, administrator rights, internet | Nothing |
| 2 | Turns on the clock service and turns off sleep | Nothing |
| 3 | Installs **Node.js** if missing | Nothing. If the automatic install fails, a web page opens: download the **LTS** `.msi`, run it, accept defaults, press Enter in the installer window. |
| 4 | **SDRplay API** | A web page opens. Under Windows, download the API installer, run it, accept defaults, then press Enter in the installer window. |
| 5 | **SDRconnect** and the receiver | Same: download, run, accept defaults, press Enter. Then plug in the RSPdx (USB 3, no hub) when asked. |
| 6 | Copies and builds RF Monitor (2-5 min) | Wait. Many lines scroll past; this is normal. |
| 7 | Settings and start-up | Choose a **Settings password** (12-128 characters) and type it twice. Write it down. |
| 8 | Starts RF Monitor and checks it | Wait up to 60 seconds |

Expected result: a green line `DONE. Double-click "RF Monitor" on the desktop`, and your browser opens the dashboard at `http://127.0.0.1:8080/`.

**If a red STOP line appears:** the installer has already stopped safely. Do what the "To fix" line says, then double-click `Install-RFMonitor.bat` again. Running it again is always safe and keeps your password and settings.

## Step 4 - Turn on the SDRconnect server

RF Monitor reads the spectrum from SDRconnect's WebSocket server on port **5454**.

- If step 7 printed `SDRconnect background service registered and started`, you are done.
- If it printed a **NOTE** that there is no background mode: open **SDRconnect**, open its settings, and turn on the **WebSocket / server** option on port `5454`. Leave SDRconnect running. The option name can differ between SDRconnect versions; look in its settings for "server" or "WebSocket".

Expected result: the dashboard receiver status changes from **Offline** to **Scanning** or **Live** within a minute.

## Daily use

- Open the **RF Monitor** icon on the desktop. It opens `http://127.0.0.1:8080/` in your browser.
- RF Monitor starts by itself when the PC starts. SDRconnect must also be running (Step 4).
- The dashboard works only on this PC. Other computers cannot open it (this is intentional).

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Double-click does nothing | Right-click `Install-RFMonitor.bat`, choose **Run as administrator** |
| Windows says "Windows protected your PC" | Click **More info**, then **Run anyway** (the file is unsigned) |
| `Node.js 20+ is still not available` | Install Node.js LTS from <https://nodejs.org>, restart the PC, run the installer again |
| `SDRplay API service is not running` | Restart the PC and run the installer again. If it persists, reinstall the API. |
| Dashboard shows **Offline** | SDRconnect is not running, or its server is off (Step 4). Check the RSPdx is plugged into a USB 3 port. |
| Page does not open | Wait a minute after start-up. Then open `C:\ProgramData\RFMonitor\runtime\rf-monitor.log` in Notepad and send the last lines to the maintainer. |
| `npm ci failed` | Check the internet connection and run the installer again |
| Forgot the Settings password | Delete `C:\ProgramData\RFMonitor\config\admin.json`, then run the installer again to choose a new one |

## Update to a newer version

Download the new ZIP (Step 1), extract it, and run `Install-RFMonitor.bat` again. Your password, settings and recordings are kept.

## Uninstall

In the `windows` folder, open PowerShell as in Step 2 and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-rfmonitor.ps1 -Uninstall
```

This removes the start-up tasks. Recordings stay in `C:\ProgramData\RFMonitor`. Delete that folder and `C:\RFMonitor` yourself if you no longer need them. Uninstall Node.js, SDRconnect and the SDRplay API from *Settings > Apps* if you want them gone.

## Where things are

| What | Where |
| --- | --- |
| Program | `C:\RFMonitor\app` |
| Settings, password hash | `C:\ProgramData\RFMonitor\config` |
| Recordings (evidence) | `C:\ProgramData\RFMonitor\evidence` |
| Log | `C:\ProgramData\RFMonitor\runtime\rf-monitor.log` |
