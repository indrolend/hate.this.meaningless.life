function commandIdentity(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

export function selectContinuationEvidence(recentEvidence, limit = 5) {
  const bounded = Number(limit);
  if (!Number.isInteger(bounded) || bounded < 1 || bounded > 20) throw new Error('Continuation handoff evidence limit must be from 1 to 20.');
  const selected = [];
  const seen = new Set();
  for (const item of recentEvidence || []) {
    const identity = commandIdentity(item.command);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    selected.push(item);
    if (selected.length >= bounded) break;
  }
  return selected;
}

export function formatContinuationHandoff(value, git, { evidenceLimit = 5 } = {}) {
  if (!value?.project || !value?.currency || !git) throw new Error('Continuation handoff requires current repository state.');
  const evidence = selectContinuationEvidence(value.recentEvidence, evidenceLimit);
  const openResult = evidence.find((item) => item.status !== 'PASS' && item.evidence === 'CURRENT') || null;
  const lines = [
    `REPO ${value.project.id}`,
    `ROOT ${value.project.root}`,
    `BRANCH ${git.branch}`,
    `HEAD ${git.head}`,
    `UPSTREAM ${git.upstream || 'none'} ahead=${git.ahead ?? 'unknown'} behind=${git.behind ?? 'unknown'}`,
    `DIRTY ${git.dirty ? 'yes' : 'no'}`,
  ];

  if (git.changedFiles?.length) {
    lines.push('', 'CHANGED');
    lines.push(...git.changedFiles);
  }

  const objective = value.workingState?.objective;
  const frontier = value.workingState?.frontier;
  if (objective) lines.push('', 'OBJECTIVE', `${objective.value} · ${objective.evidence}`);
  if (frontier) lines.push('', 'FRONTIER', `${frontier.value} · ${frontier.evidence}`);

  if (value.lastMeaningfulRun) {
    const latest = value.lastMeaningfulRun;
    lines.push('', 'LATEST', `${latest.status} ${latest.command}`, `run:${latest.runId} evidence=${latest.evidence}`);
  }

  if (openResult) {
    lines.push('', 'OPEN_RESULT', `${openResult.status} ${openResult.command}`);
    if (openResult.cause) lines.push(`${openResult.classification || 'cause'}: ${openResult.cause}`);
    lines.push(`run:${openResult.runId} evidence=${openResult.evidence}`);
  }

  if (evidence.length) {
    lines.push('', 'RECENT_EVIDENCE');
    for (const item of evidence) lines.push(`${item.status} ${item.command} · run:${item.runId} · ${item.evidence}`);
  }

  return lines.join('\n');
}
