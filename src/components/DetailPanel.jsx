import { useMemo, useState, useEffect } from 'react';
import { useUniverseStore } from '../stores/universeStore';
import { usePredictionStore } from '../stores/predictionStore';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function timeSince(dateStr) {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  const d = Math.floor(diff / 86400000);
  if (d > 365) return Math.floor(d / 365) + 'y';
  if (d > 30) return Math.floor(d / 30) + 'mo';
  if (d > 0) return d + 'd';
  const h = Math.floor(diff / 3600000);
  if (h > 0) return h + 'h';
  return '<1h';
}

function getInitials(username) {
  if (!username) return '?';
  const parts = username.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return username.slice(0, 2).toUpperCase();
}

function formatSobrietyTime(days) {
  if (!days) return '0 days';
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const remainingDays = days % 30;

  const parts = [];
  if (years > 0) parts.push(`${years}y`);
  if (months > 0) parts.push(`${months}m`);
  if (remainingDays > 0 || parts.length === 0) parts.push(`${remainingDays}d`);

  return parts.join(' ');
}

export function DetailPanel() {
  const memberId = useUniverseStore((s) => s.selectedMember);
  const selectedPost = useUniverseStore((s) => s.selectedPost);
  const members = useUniverseStore((s) => s.members);
  const posts = useUniverseStore((s) => s.posts);
  const comments = useUniverseStore((s) => s.comments);
  const setSelectedMember = useUniverseStore((s) => s.setSelectedMember);
  const setSelectedPost = useUniverseStore((s) => s.setSelectedPost);
  const version = useUniverseStore((s) => s.version);

  const predictionActive = usePredictionStore((s) => s.active);
  const predictions = usePredictionStore((s) => s.predictions);

  // Transition state
  const [isVisible, setIsVisible] = useState(false);
  const [contentKey, setContentKey] = useState(0);

  useEffect(() => {
    if (memberId || selectedPost) {
      setIsVisible(true);
      setContentKey(prev => prev + 1);
    } else {
      setIsVisible(false);
    }
  }, [memberId, selectedPost]);

  const data = useMemo(() => {
    if (!memberId) return null;
    const m = members.get(memberId);
    if (!m) return null;

    const uPosts = [];
    const uComments = [];
    const conns = {};

    posts.forEach((p, pid) => {
      if (p.creator === memberId) {
        uPosts.push({ id: pid, content: p.content, commentCount: p.commentCount, image: p.image, created: p.created });
      }
    });

    comments.forEach((c) => {
      if (c.fromMember === memberId) uComments.push(c);
      if (c.fromMember === memberId) conns[c.toMember] = 1;
      if (c.toMember === memberId) conns[c.fromMember] = 1;
    });

    const connCount = Object.keys(conns).length;

    let sobrStr = '—', sobrDays = null;
    if (m.sobriety) {
      sobrDays = Math.floor((Date.now() - new Date(m.sobriety).getTime()) / 86400000);
      sobrStr = sobrDays + ' days';
    }

    // Get prediction data
    let predData = null;
    if (predictionActive && predictions) {
      const pred = predictions.get(memberId);
      if (pred) {
        predData = { risk: pred.risk, stability: pred.stability, riskLevel: pred.riskLevel, riskFactors: pred.riskFactors };
      }
    }

    return { m, uPosts, uComments, connCount, sobrStr, sobrDays, predData };
  }, [memberId, members, posts, comments, version, predictionActive, predictions]);

  const postDetail = useMemo(() => {
    if (!selectedPost) return null;
    const post = posts.get(selectedPost);
    if (!post) return null;
    const author = members.get(post.creator);
    const postComments = [];

    comments.forEach((c) => {
      if (c.postId === selectedPost) {
        const commenter = members.get(c.fromMember);
        postComments.push({
          content: c.content,
          from: commenter ? commenter.username : c.fromMember?.slice(0, 8),
          fromId: c.fromMember,
          created: c.created,
          proPic: commenter?.proPic
        });
      }
    });

    postComments.sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());
    return { post, author, postComments };
  }, [selectedPost, posts, comments, members, version]);

  if (!memberId && !selectedPost) return null;

  const handleClose = () => {
    setSelectedMember(null);
    setSelectedPost(null);
  };

  // Instagram-style colors
  const colors = {
    bg: '#fff',
    text: '#262626',
    textLight: '#8e8e8e',
    border: '#dbdbdb',
    blue: '#0095f6',
    red: '#ed4956',
    gray: '#fafafa'
  };

  // Avatar component with initials fallback
  const Avatar = ({ src, username, size = 32, border = null }) => (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: src ? `url(${src})` : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#fff',
      fontSize: size * 0.4,
      fontWeight: 600,
      border: border || 'none',
      flexShrink: 0,
    }}>
      {!src && getInitials(username)}
    </div>
  );

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      right: isVisible ? 0 : -420,
      width: 420,
      height: '100vh',
      background: colors.bg,
      boxShadow: '-2px 0 16px rgba(0,0,0,0.1)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 100,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      transition: 'right 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    }}>

      {/* Header */}
      <div style={{
        padding: '14px 16px',
        borderBottom: `1px solid ${colors.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: colors.bg,
      }}>
        <button type="button" onClick={handleClose} style={{
          background: 'none',
          border: 'none',
          fontSize: 28,
          cursor: 'pointer',
          color: colors.text,
          padding: 0,
          lineHeight: 1,
        }}>×</button>
        {selectedPost && memberId && (
          <button type="button" onClick={() => setSelectedPost(null)} style={{
            background: 'none',
            border: 'none',
            color: colors.blue,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}>← Back</button>
        )}
      </div>

      {/* Content area with scroll */}
      <div key={contentKey} style={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        animation: 'fadeIn 0.3s ease-in-out',
      }}>

        {/* POST DETAIL VIEW */}
        {postDetail && selectedPost && (
          <div>
            {/* Post image */}
            {postDetail.post.image && (
              <img
                src={postDetail.post.image}
                alt=""
                style={{
                  width: '100%',
                  maxHeight: 420,
                  objectFit: 'cover',
                  display: 'block'
                }}
              />
            )}

            {/* Post content */}
            <div style={{ padding: 16 }}>
              {/* Author */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <Avatar src={postDetail.author?.proPic} username={postDetail.author?.username || 'unknown'} size={32} />
                <div style={{ flex: 1 }}>
                  <div
                    onClick={() => {
                      if (postDetail.post.creator) {
                        setSelectedMember(postDetail.post.creator);
                        setSelectedPost(null);
                      }
                    }}
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: colors.text,
                      cursor: 'pointer',
                    }}
                  >
                    {postDetail.author ? esc(postDetail.author.username) : 'unknown'}
                  </div>
                  <div style={{ fontSize: 12, color: colors.textLight }}>
                    {postDetail.post.created && timeSince(postDetail.post.created)}
                  </div>
                </div>
              </div>

              {/* Caption */}
              <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.5, marginBottom: 16 }}>
                <span style={{ fontWeight: 600, marginRight: 6 }}>
                  {postDetail.author ? esc(postDetail.author.username) : 'unknown'}
                </span>
                {esc(postDetail.post.content || '')}
              </div>

              {/* Comments */}
              {postDetail.postComments.length > 0 && (
                <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 12 }}>
                  <div style={{ fontSize: 12, color: colors.textLight, fontWeight: 600, marginBottom: 12 }}>
                    {postDetail.postComments.length} {postDetail.postComments.length === 1 ? 'comment' : 'comments'}
                  </div>
                  {postDetail.postComments.map((c, i) => (
                    <div key={i} style={{ marginBottom: 12, display: 'flex', gap: 10 }}>
                      <Avatar src={c.proPic} username={c.from} size={28} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.4 }}>
                          <span
                            onClick={() => { if (c.fromId) setSelectedMember(c.fromId); }}
                            style={{ fontWeight: 600, cursor: 'pointer', marginRight: 6 }}
                          >
                            {esc(c.from)}
                          </span>
                          {esc(c.content)}
                        </div>
                        <div style={{ fontSize: 12, color: colors.textLight, marginTop: 4 }}>
                          {c.created && timeSince(c.created)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* PROFILE VIEW */}
        {data && !selectedPost && (
          <div>
            {/* Profile header */}
            <div style={{ padding: '24px 16px', textAlign: 'center' }}>
              <div style={{ display: 'inline-block', margin: '0 auto 16px' }}>
                <Avatar
                  src={data.m.proPic}
                  username={data.m.username}
                  size={86}
                  border={data.predData ? `3px solid ${
                    data.predData.riskLevel === 'high' ? colors.red :
                    data.predData.riskLevel === 'watch' ? '#ffa726' :
                    '#4caf50'
                  }` : 'none'}
                />
              </div>

              <h2 style={{
                fontSize: 20,
                fontWeight: 600,
                color: colors.text,
                margin: '0 0 8px 0'
              }}>
                {esc(data.m.username)}
              </h2>

              {/* Sobriety timeline visual */}
              {data.sobrDays > 0 && (
                <div style={{
                  margin: '16px 0',
                  padding: 12,
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  borderRadius: 12,
                  color: '#fff'
                }}>
                  <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>
                    {formatSobrietyTime(data.sobrDays)}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.9 }}>
                    🎉 Sober since {new Date(data.m.sobriety).toLocaleDateString()}
                  </div>
                  <div style={{
                    marginTop: 8,
                    height: 4,
                    background: 'rgba(255,255,255,0.2)',
                    borderRadius: 2,
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.min((data.sobrDays / 365) * 100, 100)}%`,
                      background: '#fff',
                      borderRadius: 2,
                      transition: 'width 0.5s ease'
                    }} />
                  </div>
                  <div style={{ fontSize: 11, marginTop: 6, opacity: 0.8 }}>
                    {data.sobrDays < 365 ?
                      `${Math.round((data.sobrDays / 365) * 100)}% to 1 year` :
                      `${Math.floor(data.sobrDays / 365)} year${Math.floor(data.sobrDays / 365) > 1 ? 's' : ''} milestone reached! 🏆`
                    }
                  </div>
                </div>
              )}

              {/* Stats row */}
              <div style={{
                display: 'flex',
                justifyContent: 'center',
                gap: 32,
                marginTop: 20,
                paddingBottom: 20,
                borderBottom: `1px solid ${colors.border}`
              }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 600, color: colors.text }}>
                    {data.uPosts.length}
                  </div>
                  <div style={{ fontSize: 12, color: colors.textLight }}>posts</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 600, color: colors.text }}>
                    {data.connCount}
                  </div>
                  <div style={{ fontSize: 12, color: colors.textLight }}>connections</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 600, color: colors.text }}>
                    {data.uComments.length}
                  </div>
                  <div style={{ fontSize: 12, color: colors.textLight }}>comments</div>
                </div>
              </div>
            </div>

            {/* Prediction data */}
            {data.predData && (
              <div style={{
                padding: 16,
                margin: '0 16px 16px',
                background: colors.gray,
                borderRadius: 12
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 12 }}>
                  Risk Assessment
                </div>
                <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: colors.textLight, marginBottom: 4 }}>Risk Level</div>
                    <div style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: data.predData.riskLevel === 'high' ? colors.red :
                             data.predData.riskLevel === 'watch' ? '#ffa726' :
                             '#4caf50'
                    }}>
                      {data.predData.riskLevel.toUpperCase()}
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: colors.textLight, marginBottom: 4 }}>Risk Score</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
                      {Math.round(data.predData.risk * 100)}%
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: colors.textLight, marginBottom: 4 }}>Stability</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
                      {Math.round(data.predData.stability * 100)}%
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Posts grid */}
            {data.uPosts.length > 0 && (
              <div style={{ padding: '0 0 16px' }}>
                <div style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: colors.textLight,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  padding: '0 16px 12px'
                }}>
                  Posts
                </div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 2
                }}>
                  {data.uPosts.slice(0, 12).map((p) => (
                    <div
                      key={p.id}
                      onClick={() => setSelectedPost(p.id)}
                      style={{
                        aspectRatio: '1',
                        background: p.image ? `url(${p.image})` : colors.gray,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        cursor: 'pointer',
                        position: 'relative',
                      }}
                    >
                      {!p.image && (
                        <div style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 11,
                          color: colors.textLight,
                          padding: 8,
                          textAlign: 'center',
                          overflow: 'hidden',
                        }}>
                          {esc(p.content?.slice(0, 50) || '...')}
                        </div>
                      )}
                      {p.commentCount > 0 && (
                        <div style={{
                          position: 'absolute',
                          top: 6,
                          right: 6,
                          background: 'rgba(0,0,0,0.6)',
                          color: '#fff',
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '2px 6px',
                          borderRadius: 4,
                        }}>
                          💬 {p.commentCount}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
