import type {
  BandCatalog,
  BandPreset,
  ChannelMonitorState,
  GnssConstellation,
  GroupCoverageState,
  GroupSignalState,
  MonitorFeed,
  MonitorGroup,
  MonitorGroupMember,
  MonitorTarget,
  ServiceCoverageSummary,
  ServiceGroup,
} from './types';

const CONSTELLATIONS: GnssConstellation[] = ['GPS', 'Galileo', 'GLONASS', 'BeiDou', 'SBAS'];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mhz(value: number, digits = 3): string {
  return (value / 1_000_000).toFixed(digits).replace(/\.?0+$/, '') + ' MHz';
}

function rangeLabel(startHz: number, endHz: number): string {
  return mhz(startHz, 3).replace(' MHz', '') + '–' + mhz(endHz, 3);
}

function relatedTargets(bandId: string, targets: MonitorTarget[]): MonitorTarget[] {
  return targets.filter((target) => target.relatedBandIds.includes(bandId));
}

function constellationMember(band: BandPreset, targets: MonitorTarget[]): MonitorGroupMember {
  const related = relatedTargets(band.id, targets);
  return {
    id: 'signal-' + band.id,
    label: band.signal || band.label,
    coverageLabel: mhz(band.centerHz, 3),
    bandIds: [band.id],
    targetIds: related.map((target) => target.id),
    centerHz: band.centerHz,
    startHz: band.startHz,
    endHz: band.endHz,
    priority: related.some((target) => target.priority),
  };
}

function targetChannelRange(target: MonitorTarget, reference: BandPreset): [number, number] | undefined {
  if (!reference.channelSpacingHz || !reference.channelCount) return undefined;
  const first = Math.max(1, Math.ceil((target.startHz - reference.startHz) / reference.channelSpacingHz) + 1);
  const last = Math.min(reference.channelCount, Math.floor((target.endHz - reference.startHz) / reference.channelSpacingHz) + 1);
  return first <= last ? [first, last] : undefined;
}

function radioMember(target: MonitorTarget, band: BandPreset, reference: BandPreset): MonitorGroupMember {
  const selected = (band.selectedFrequenciesHz || []).filter((frequency) => frequency >= target.startHz && frequency <= target.endHz);
  const channels = targetChannelRange(target, reference);
  let label = 'Coverage section';
  if (selected.length === 1) label = mhz(selected[0], 3);
  else if (selected.length > 1) label = selected.length + ' frequencies';
  else if (channels) label = channels[0] === channels[1] ? 'Channel ' + channels[0] : 'Channels ' + channels[0] + '–' + channels[1];
  return {
    id: 'section-' + target.id,
    label,
    coverageLabel: rangeLabel(target.startHz, target.endHz),
    bandIds: target.relatedBandIds,
    targetIds: [target.id],
    centerHz: target.centerHz,
    startHz: target.startHz,
    endHz: target.endHz,
    priority: target.priority,
  };
}

function radioGroup(
  service: Exclude<ServiceGroup, 'gnss'>,
  catalog: BandCatalog,
  activeBands: BandPreset[],
  targets: MonitorTarget[],
  summaries: ServiceCoverageSummary[],
): MonitorGroup {
  const definition = catalog.services.find((candidate) => candidate.id === service);
  const summary = summaries.find((candidate) => candidate.service === service);
  const band = activeBands.find((candidate) => candidate.service === service);
  const reference = catalog.bands.find((candidate) => candidate.service === service);
  const serviceTargets = targets.filter((target) => target.service === service);
  const members = band && reference ? serviceTargets.map((target) => radioMember(target, band, reference)) : [];
  return {
    id: 'service-' + service,
    label: definition?.label || service,
    description: definition?.description || 'Radio coverage',
    service,
    kind: 'radio',
    enabled: Boolean(summary?.enabled && members.length),
    coverageLabel: summary?.enabled ? summary.coverageLabel : 'Off',
    targetIds: serviceTargets.map((target) => target.id),
    members,
  };
}

export function createMonitorGroups(
  catalog: BandCatalog,
  activeBands: BandPreset[],
  targets: MonitorTarget[],
  summaries: ServiceCoverageSummary[],
): MonitorGroup[] {
  const activeBandIds = new Set(activeBands.map((band) => band.id));
  const gnssGroups = CONSTELLATIONS.map((constellation): MonitorGroup => {
    const catalogBands = catalog.bands.filter((band) => band.service === 'gnss' && band.constellation === constellation);
    const active = catalogBands.filter((band) => activeBandIds.has(band.id));
    const memberBands = active.length ? active : catalogBands;
    const members = memberBands.map((band) => constellationMember(band, targets));
    const signalNames = active.map((band) => band.signal || band.label);
    return {
      id: 'gnss-' + constellation.toLowerCase(),
      label: constellation,
      description: constellation + ' navigation signals',
      service: 'gnss',
      kind: 'constellation',
      enabled: active.length > 0,
      coverageLabel: signalNames.length ? signalNames.join(', ') : 'Off',
      targetIds: unique(members.flatMap((member) => member.targetIds)),
      members,
    };
  });
  return [
    radioGroup('startrack', catalog, activeBands, targets, summaries),
    radioGroup('4dx', catalog, activeBands, targets, summaries),
    ...gnssGroups,
  ];
}

export function createMonitorFeeds(
  catalog: BandCatalog,
  activeBands: BandPreset[],
  targets: MonitorTarget[],
  summaries: ServiceCoverageSummary[],
): MonitorFeed[] {
  const feeds: MonitorFeed[] = [];
  for (const service of ['startrack', '4dx'] as const) {
    const serviceTargets = targets.filter((target) => target.service === service);
    const summary = summaries.find((candidate) => candidate.service === service);
    const definition = catalog.services.find((candidate) => candidate.id === service);
    if (!serviceTargets.length || !summary?.enabled) continue;
    const startHz = Math.min(...serviceTargets.map((target) => target.startHz));
    const endHz = Math.max(...serviceTargets.map((target) => target.endHz));
    const centerHz = Math.round((startHz + endHz) / 2);
    const focusTarget = [...serviceTargets].sort((left, right) => Math.abs(left.centerHz - centerHz) - Math.abs(right.centerHz - centerHz))[0];
    feeds.push({
      id: 'survey-' + service,
      label: definition?.label || service,
      shortLabel: definition?.label || service,
      description: definition?.description || 'Radio survey',
      service,
      category: 'radio',
      kind: 'stitched-sweep',
      enabled: true,
      coverageLabel: rangeLabel(startHz, endHz),
      targetIds: serviceTargets.map((target) => target.id),
      bandIds: unique(serviceTargets.flatMap((target) => target.relatedBandIds)),
      startHz,
      endHz,
      centerHz,
      priority: false,
      focusTargetId: focusTarget?.id,
      focusBandId: focusTarget?.relatedBandIds[0],
      focusCenterHz: focusTarget?.centerHz,
    });
  }

  const gnssBands = activeBands.filter((band) => band.service === 'gnss');
  const physicalGroups = new Map<string, BandPreset[]>();
  for (const band of gnssBands) {
    const key = band.captureTargetId ?? `legacy-${band.centerHz}`;
    const grouped = physicalGroups.get(key) ?? [];
    grouped.push(band);
    physicalGroups.set(key, grouped);
  }
  for (const [physicalTargetId, bandsAtFrequency] of physicalGroups) {
    const bandIds = bandsAtFrequency.map((band) => band.id);
    const relevantTargets = targets
      .filter((target) => target.service === 'gnss' && (target.id === physicalTargetId || target.relatedBandIds.some((bandId) => bandIds.includes(bandId))))
      .sort((left, right) => Number(right.priority) - Number(left.priority));
    const focusTarget = relevantTargets[0];
    if (!focusTarget) continue;
    const centerHz = focusTarget.centerHz;
    const label = unique(bandsAtFrequency.map((band) => [band.constellation, band.signal].filter(Boolean).join(' '))).join(' / ');
    const shortLabel = unique(bandsAtFrequency.map((band) => band.signal || band.label)).join(' / ');
    feeds.push({
      id: 'window-' + physicalTargetId,
      label,
      shortLabel,
      description: 'Navigation signal window',
      service: 'gnss',
      category: 'navigation',
      kind: 'capture-window',
      enabled: true,
      coverageLabel: mhz(centerHz, 3),
      targetIds: [focusTarget.id],
      bandIds,
      startHz: focusTarget.startHz,
      endHz: focusTarget.endHz,
      centerHz,
      priority: relevantTargets.some((target) => target.priority),
      focusTargetId: focusTarget.id,
      focusBandId: bandsAtFrequency[0].id,
      focusCenterHz: centerHz,
    });
  }

  return feeds.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority ? -1 : 1;
    if (left.category !== right.category) return left.category === 'radio' ? -1 : 1;
    return left.startHz - right.startHz;
  });
}

export function signalStateForTargets(targetIds: string[], states: ChannelMonitorState[]): GroupSignalState {
  const relevant = states.filter((state) => targetIds.includes(state.targetId));
  const lifecycles = relevant.map((state) => state.lifecycle);
  if (lifecycles.includes('active')) return 'alert';
  if (lifecycles.includes('recovering')) return 'recovering';
  if (lifecycles.includes('detecting') || relevant.some((state) => (
    state.observationDisposition === 'unknown' || state.baselineLifecycle !== 'protected'
  ))) return 'checking';
  return 'normal';
}

export function coverageStateForGroup(
  group: MonitorGroup,
  states: ChannelMonitorState[],
  targets: MonitorTarget[],
  now: number,
  paused: boolean,
  monitoringReady: boolean,
): GroupCoverageState {
  if (paused) return 'paused';
  if (!monitoringReady) return 'offline';
  if (!group.targetIds.length) return 'scanning';
  const targetMap = new Map(targets.map((target) => [target.id, target]));
  const groupStates = group.targetIds.map((id) => states.find((state) => state.targetId === id));
  if (groupStates.some((state) => !state?.lastObservedAt)) return 'scanning';
  const late = groupStates.some((state) => {
    const observedAt = Date.parse(state!.lastObservedAt!);
    const expected = targetMap.get(state!.targetId)?.expectedRevisitMs || 5_000;
    return !Number.isFinite(observedAt) || now - observedAt > Math.max(15_000, expected * 2.5);
  });
  return late ? 'data-late' : 'live';
}

export const SIGNAL_STATE_COPY: Record<GroupSignalState, { label: string; detail: string }> = {
  normal: { label: 'Normal', detail: 'Recent scans look normal.' },
  checking: { label: 'Checking', detail: 'Checking a signal change.' },
  alert: { label: 'Alert', detail: 'Signal above normal.' },
  recovering: { label: 'Recovering', detail: 'Signal returning to normal.' },
};

export const COVERAGE_STATE_COPY: Record<GroupCoverageState, string> = {
  live: 'Live',
  scanning: 'Scanning',
  'data-late': 'Data late',
  paused: 'Paused',
  offline: 'Offline',
};
