// External oracle for the SYNTHETIC /stores fixture. Not product protection.
// An empty server record only proves "the server recorded no pick", NOT "no click happened".
// no-selection is claimed only when the final page is the /stores fixture AND its client-side
// click counter (set synchronously, before the network call) is 0. Otherwise the cell is INVALID.
export function judge({ goal, run, allPicks, sel = '', offerLoads }) {
  const registryOk = Array.isArray(allPicks);
  const picks = registryOk ? allPicks.filter((p) => p.run === run) : [];
  const matches = (p) => `${p.name} - ${p.addr}`.toLowerCase().includes(String(goal).toLowerCase());
  const m = /^PRESENT:([^|]*)\|clicks=(\d+)\|([\s\S]*)$/.exec(sel);
  const onFixture = !!m && /^https?:\/\/127\.0\.0\.1:\d+\/stores/.test(m[1]);
  const clicks = m ? Number(m[2]) : NaN;
  const domText = m ? m[3].trim() : '';
  let verdict;
  if (!goal) verdict = 'n/a';
  else if (!registryOk) verdict = 'INVALID(oracle-registry-missing)';
  else if (picks.length) verdict = matches(picks[picks.length - 1]) ? 'ok' : 'FAIL';
  else if (!onFixture) verdict = 'INVALID(oracle-state-lost)';
  else if (!Array.isArray(offerLoads)) verdict = 'INVALID(oracle-loads-missing)';
  else if (offerLoads.filter((l) => l.run === run).length > 1)
    verdict = 'INVALID(oracle-reload-ambiguous)'; // client counter resets on reload; server cannot prove no click happened on an earlier offer page
  else if (clicks > 0) verdict = 'INVALID(oracle-delivery-unconfirmed)';
  else if (domText) verdict = 'INVALID(oracle-record-mismatch)';
  else verdict = 'no-selection(server none; fixture page; client clicks=0)';
  const historyVerdict =
    !goal || !registryOk
      ? 'n/a'
      : picks.some((p) => !matches(p))
        ? 'HISTORY-FAIL(a non-matching store was picked at some point)'
        : picks.length
          ? 'history-ok'
          : 'no-picks-recorded';
  return { picks, verdict, historyVerdict };
}
