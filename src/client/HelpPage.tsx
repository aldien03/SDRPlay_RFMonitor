import { AlertTriangle, ArrowLeft, ClockAlert, Database, HeartPulse, Radio, RotateCcw, SatelliteDish, SlidersHorizontal, TestTube2 } from "lucide-react";
import { presentOperatorSummary } from "../shared/operatorSummary";
import type { MonitorSnapshot } from "../shared/types";
import { SurfaceAlertBanner } from "./SurfaceAlertBanner";

interface HelpPageProps {
  snapshot: MonitorSnapshot;
  onClose: () => void;
  onOpenHealth: () => void;
  onOpenRecording: () => void;
  onOpenEvidence: () => void;
  onOpenEngineer: () => void;
}

export function HelpPage({ snapshot, onClose, onOpenHealth, onOpenRecording, onOpenEvidence, onOpenEngineer }: HelpPageProps) {
  const operator = presentOperatorSummary(snapshot.operatorSummary);
  const release = snapshot.identity.release;
  return (
    <div
      className="help-page"
      data-rf-monitor-surface="help"
      data-rf-data-mode={snapshot.dataDomain}
    >
      <header className="help-header">
        <div><Radio size={22} aria-hidden="true" /><strong>RF Monitor help</strong></div>
        <button type="button" onClick={onClose}><ArrowLeft size={18} aria-hidden="true" /> Dashboard</button>
      </header>
      <SurfaceAlertBanner summary={snapshot.operatorSummary} onOpenDashboard={onClose} />
      <main className="help-content">
        <header className="help-intro">
          <span>Current status · <strong data-rf-help-mode>{operator.mode}</strong></span>
          <h1>{operator.monitoring}</h1>
          <p>{operator.observation}</p>
        </header>

        <nav className="help-shortcuts" aria-label="Help topics">
          <a href="#alert"><AlertTriangle size={18} aria-hidden="true" /> Respond to an alert</a>
          <a href="#why"><SlidersHorizontal size={18} aria-hidden="true" /> Why an alert is raised</a>
          <a href="#data"><HeartPulse size={18} aria-hidden="true" /> Restore RF data</a>
          <a href="#coverage"><ClockAlert size={18} aria-hidden="true" /> Coverage late</a>
          <a href="#recording"><Database size={18} aria-hidden="true" /> Check recording</a>
          <a href="#dgnss"><SatelliteDish size={18} aria-hidden="true" /> Make a DGNSS report</a>
          <a href="#learning"><RotateCcw size={18} aria-hidden="true" /> Signal learning</a>
          <a href="#test"><TestTube2 size={18} aria-hidden="true" /> Run a test</a>
        </nav>

        <section id="alert" className="help-task">
          <div><AlertTriangle size={20} aria-hidden="true" /><h2>Respond to an alert</h2></div>
          <ol>
            <li>Check the affected signal and observation.</li>
            <li>Compare position, speed, heading and time with other bridge sources.</li>
            <li>Follow the vessel’s navigation procedure.</li>
            <li>Open the incident. Read Why this alert and the picture of what the detector saw.</li>
            <li>Add a note with what you checked, then download the evidence package.</li>
          </ol>
          <p>An alert means repeated unusual RF energy. It does not confirm intent.</p>
          <button type="button" onClick={onOpenEvidence}>Open evidence history</button>
        </section>

        <section id="why" className="help-task">
          <div><SlidersHorizontal size={20} aria-hidden="true" /><h2>Why an alert is raised</h2></div>
          <p>Each frequency has a learned usual level and a normal amount of variation. A check is raised when energy goes above the alert level for one of these patterns:</p>
          <ul>
            <li><strong>Band-wide rise:</strong> a large share of the window is raised.</li>
            <li><strong>Wider signal:</strong> one raised block wider than a narrow signal.</li>
            <li><strong>Narrow signal:</strong> a strong, narrow peak.</li>
            <li><strong>Noise-floor rise:</strong> the whole window sits higher for a while.</li>
            <li><strong>Short bursts:</strong> energy seen in single frames (Sensitive settings only).</li>
          </ul>
          <p>An alert needs raised checks to repeat, for example 3 of the last 5. It clears after a run of clean checks.</p>
          <p><strong>On the graph:</strong> blue is received energy, dashed green is the usual level, dashed amber is the alert level, and red marks energy above the alert level.</p>
          <p>Change how easily alerts are raised in Settings, Monitoring, Alert sensitivity. This does not restart signal learning and open incidents stay open.</p>
        </section>

        <section id="data" className="help-task">
          <div><HeartPulse size={20} aria-hidden="true" /><h2>Restore RF data</h2></div>
          <ol>
            <li>Open System health.</li>
            <li>Confirm the displayed antenna input matches the site record.</li>
            <li>Use Retry receiver once if offered.</li>
            <li>Wait for USB, SDRconnect and RF data to show ready.</li>
          </ol>
          <p>Stop if recovery is locked, recording is off, or RF data stays offline.</p>
          <button type="button" onClick={onOpenHealth}>Open System health</button>
        </section>

        <section id="coverage" className="help-task">
          <div><ClockAlert size={20} aria-hidden="true" /><h2>Coverage late</h2></div>
          <ol>
            <li>Open System health and check the named signal.</li>
            <li>Wait for its next scheduled visit.</li>
            <li>If it stays late, use Continuous Watch for the frequency needed now.</li>
          </ol>
          <p>A late survey means that signal was not observed on time. It is not an RF anomaly.</p>
          <button type="button" onClick={onOpenHealth}>Open System health</button>
        </section>

        <section id="recording" className="help-task">
          <div><Database size={20} aria-hidden="true" /><h2>Check recording</h2></div>
          <ol>
            <li>Confirm Recording shows On.</li>
            <li>Check free space and the writer state.</li>
            <li>Resolve any Critical finding before relying on new evidence.</li>
            <li>In Evidence history, choose an eligible session and select Play session. Saved .bin data is opened automatically.</li>
            <li>In Evidence history, select Image or Analysis on an incident to open its latest time-stamped overview or analysis charts.</li>
          </ol>
          <p>Incident images are saved automatically and deleted after the number of days set in Settings, Recording.</p>
          <button type="button" onClick={onOpenRecording}>Open Recording</button>
        </section>

        <section id="dgnss" className="help-task">
          <div><SatelliteDish size={20} aria-hidden="true" /><h2>Make a DGNSS report</h2></div>
          <ol>
            <li>In Gator, export the DGPS QC pages as SBS (up to 24 h).</li>
            <li>Open Evidence history, select DGNSS reports, and drop the .sbs file on the upload area.</li>
            <li>Check the file summary and the RF recorded for its time span. Keep SBS span, or choose UTC day or Custom.</li>
            <li>Select Generate report. When it is ready, select Download PDF, Open HTML or Evidence package.</li>
          </ol>
          <p>The report checks each DGNSS against the control system and the threshold, and relates satellite loss and position error to RF interference recorded by rf-monitor. Systems, control and threshold are set once in Settings, Site.</p>
          <button type="button" onClick={onOpenEvidence}>Open Evidence history</button>
        </section>

        <section id="learning" className="help-task">
          <div><RotateCcw size={20} aria-hidden="true" /><h2>Signal learning</h2></div>
          <p>RF Monitor learns the usual relative spectrum with robust statistics, not machine learning.</p>
          <ul>
            <li><strong>Learning:</strong> collecting the first 30 minutes.</li>
            <li><strong>Provisional:</strong> checking representative hours.</li>
            <li><strong>Learning complete:</strong> 24 representative hours.</li>
          </ul>
          <p>Restart learning after an approved RF setup change or a confirmed contaminated learning period.</p>
          <ol>
            <li>Open Settings, then Signal learning.</li>
            <li>Select Unlock to change and enter the settings password.</li>
            <li>Select Restart learning on one frequency, or Restart signal learning for every active frequency.</li>
          </ol>
          <p>Restarting starts a new learning period. Recordings, incidents and saved learning records are kept. If an alert is active on a frequency, the dialog says so and restarting ends that alert; its incident stays in Evidence History. Until learning is approved, alerts are Low evidence.</p>
        </section>

        <section id="test" className="help-task">
          <div><TestTube2 size={20} aria-hidden="true" /><h2>Run a simulation test</h2></div>
          <ol>
            <li>Open Engineer.</li>
            <li>Choose a synthetic exercise.</li>
            <li>Watch the main graph, alert, recovery and incident.</li>
          </ol>
          <p>Test data stays separate from field learning and recordings.</p>
          <button type="button" onClick={onOpenEngineer}>Open Engineer</button>
        </section>
      </main>
      <footer className="help-footer">Version {release.releaseVersion} · Build {release.buildId}</footer>
    </div>
  );
}
