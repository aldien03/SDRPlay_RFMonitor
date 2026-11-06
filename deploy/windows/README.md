# Windows 11 installer

Evaluation only; production is Ubuntu 24.04. **Full step-by-step guide: [docs/windows-11.md](../../docs/windows-11.md).**

Short version: download the ZIP from GitHub, extract it, open `deploy\windows`, double-click **`Install-RFMonitor.bat`**, and follow the on-screen steps. It installs Node.js, guides you through the SDRplay API and SDRconnect, builds the app, sets a Settings password, registers start-up tasks and checks that the dashboard answers.

| File | Purpose |
| --- | --- |
| `Install-RFMonitor.bat` | Double-click launcher; asks for administrator rights |
| `install-rfmonitor.ps1` | The installer. Options: `-CheckOnly`, `-Uninstall` |

Note: this script has not yet been run on a real Windows 11 machine.
