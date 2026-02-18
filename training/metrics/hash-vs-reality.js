/**
 * Compare encoded metadata (from hash) vs actual counts. Hash accuracy %.
 */
export function hashVsReality(state) {
  const { members, posts, comments, metadataHashes } = state;
  let totalScore = 0;
  let memberCount = 0;
  const perMember = [];

  metadataHashes.forEach((mh, mid) => {
    const m = members.get(mid);
    if (!m) return;
    let apc = 0, acc = 0;
    const aco = {};
    posts.forEach((p) => { if (p.creator === mid) apc++; });
    comments.forEach((c) => { if (c.fromMember === mid) acc++; });
    comments.forEach((c) => {
      if (c.fromMember === mid) aco[c.toMember] = 1;
      if (c.toMember === mid) aco[c.fromMember] = 1;
    });
    const ch = 3;
    let ma = 0;
    if (mh.encoded.postCount === apc) ma++;
    if (mh.encoded.commentCount === acc) ma++;
    if (mh.encoded.connections === Object.keys(aco).length) ma++;
    const score = ma / ch;
    totalScore += score;
    memberCount++;
    perMember.push({ mid, postCount: apc, commentCount: acc, connections: Object.keys(aco).length, encoded: mh.encoded, score });
  });

  const accuracyPct = memberCount > 0 ? Math.round((totalScore / memberCount) * 100) : 0;
  return {
    accuracyPct,
    memberCount,
    totalScore,
    perMember: perMember.slice(0, 20),
  };
}
