// Repair module "dequantizeTime" — fix 1-second-resolution timestamps. A device that stamps time to the
// whole second collapses sub-second samples onto a DUPLICATE integer second. Each run of identical
// stamps is `len` real fixes that each want their own 1 Hz slot; place them on the integer grid,
// choosing the side with room:
//   - forward: the next fix is far enough (>= len s) -> first stays at t, the rest step +1 s each.
//   - back:    no forward room but an empty slot exists before -> PULL the run back into the gap
//              (1 2 2 5 5 -> 1 2 3 4 5), so a fix that was delayed-stamped lands in its real slot.
//   - compress: hemmed in on both sides (prev and next both adjacent) -> spread to sub-seconds; the
//              squeezed sample is genuine >1 Hz and oversample drops it later.
// A point never moves more than ~1 s; a 2 s+ gap is "no signal", not room to spread into. Positions
// are untouched — only `time` moves, recorded via `edit` (-> point.edited.time), never dropped.

const SEC = 1000;

export const repair = (points, edit) => {
  const n = points.length;
  let i = 0;
  while (i < n) {
    const t = points[i].time;
    if (t == null) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && points[j].time === t) j++; // maximal run of identical timestamps
    const len = j - i;
    if (len > 1) {
      const tPrev = i > 0 && points[i - 1].time != null ? points[i - 1].time : null;
      const tNext = j < n && points[j].time != null && points[j].time > t ? points[j].time : null;

      let target;
      if (tNext != null && tNext - t >= len * SEC) {
        target = (k) => t + k * SEC; // forward — first stays at t, the rest step +1 s
      } else {
        const pullEnd = tNext != null ? tNext - SEC : t; // run ends just before the next fix (or at t)
        const pullStart = pullEnd - (len - 1) * SEC;
        if (tPrev != null && pullStart >= tPrev + SEC && pullStart < t) {
          target = (k) => pullStart + k * SEC; // back — earlier members fill the empty slots before t
        } else {
          const step = Math.min(SEC, (tNext != null ? tNext - t : SEC) / len);
          target = (k) => t + k * step; // compress within the available second
        }
      }

      for (let k = 0; k < len; k++) {
        const nt = target(k);
        if (nt !== t) edit(points[i + k], "time", nt);
      }
    }
    i = j;
  }
};
