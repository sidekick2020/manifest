/**
 * Member detail side panel. Same structure as test-point-cloud.html #detail.
 * Legacy script expects these ids: detail-drag-handle, close, detail-avatar,
 * detail-username, detail-id, detail-stats, detail-beams-count, detail-planets-count,
 * supporters-section, supporter-cards-container, posts-grid, post-expanded, etc.
 */
export function DetailPanel() {
  return (
    <div id="detail">
      <div id="detail-drag-handle" className="detail-drag-handle" aria-hidden="true" />
      <span className="close" onClick={() => window.closeDetail?.()} aria-label="Close panel" role="button" tabIndex={0}>
        ✕
      </span>
      <div className="detail-header">
        <div className="detail-avatar" id="detail-avatar">
          {/* Profile picture or initials */}
        </div>
        <div className="detail-header-info">
          <h3 id="detail-username">-</h3>
          <div className="detail-header-id">
            <strong>ID:</strong> <span id="detail-id">-</span>
          </div>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-block"
        style={{ marginTop: '10px' }}
        onClick={() => window.focusOnSelected?.()}
      >
        Zoom to Member
      </button>

      <div id="detail-stats" className="detail-stats">
        <div className="detail-stat-card beams">
          <span className="detail-stat-icon" aria-hidden="true">
            ✨
          </span>
          <span id="detail-beams-count" className="detail-stat-value">
            0
          </span>
          <span className="detail-stat-label">Beams</span>
          <span className="detail-stat-desc">Times they supported others</span>
        </div>
        <div className="detail-stat-card planets">
          <span className="detail-stat-icon" aria-hidden="true">
            🪐
          </span>
          <span id="detail-planets-count" className="detail-stat-value">
            0
          </span>
          <span className="detail-stat-label">Planets</span>
          <span className="detail-stat-desc">Stories they shared</span>
        </div>
      </div>

      <div id="supporters-section" style={{ display: 'none', margin: '20px 0 0 0' }}>
        <h4
          style={{
            margin: '0 0 16px 0',
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--color-text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Top Supported
        </h4>
        <div id="supporter-cards-container" style={{ position: 'relative', height: '160px' }} />
      </div>

      <div className="posts-section">
        <h4>Posts</h4>
        <div id="posts-grid" className="posts-grid">
          <div className="posts-loading">Loading posts...</div>
        </div>
      </div>

      <div id="post-expanded">
        <button type="button" className="post-expanded-back" onClick={() => window.closeExpandedPost?.()}>
          ←
        </button>
        <div className="post-expanded-content">
          <img
            id="post-expanded-image"
            className="post-expanded-image"
            crossOrigin="anonymous"
            style={{ display: 'none' }}
            alt=""
          />
          <div id="post-expanded-text" className="post-expanded-text" />
          <div id="post-expanded-meta" className="post-expanded-meta" />
        </div>
        <div className="post-comments-section">
          <h4 className="post-comments-header">
            Comments <span id="comment-count" />
          </h4>
          <div id="post-comments-list">
            <div className="comments-loading">Loading comments...</div>
          </div>
        </div>
      </div>
    </div>
  );
}
