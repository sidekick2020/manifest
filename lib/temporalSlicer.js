/**
 * Temporal Slicer - Shows one snapshot/slice of time from a massive dataset
 *
 * Key concept: Instead of rendering all 100K members, show only members from
 * a specific time window (e.g., "members who joined in March 2024" or "active in last 30 days")
 *
 * This allows infinite dataset storage while keeping render count manageable.
 */

export class TemporalSlicer {
  constructor() {
    this.currentSlice = null; // Current time window being displayed
    this.sliceMode = 'recent'; // 'recent', 'date-range', 'cohort', 'activity'
    this.cache = null;         // Cached slice result
    this.cacheKey = null;      // Cache invalidation key
    this.cacheTimestamp = 0;   // When cache was created
  }

  /**
   * Get cache key for current slice parameters
   */
  _getCacheKey(members, options) {
    return `${members.size}-${options.mode || 'recent'}-${options.windowSize || 1000}-${options.page || 0}`;
  }

  /**
   * Invalidate cache (call when members change)
   */
  invalidateCache() {
    this.cache = null;
    this.cacheKey = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Slice members by time window
   * @param {Map} members - Full member dataset
   * @param {Object} options - Slicing options
   * @returns {Map} Subset of members to render
   */
  slice(members, options = {}) {
    // Check cache first
    const cacheKey = this._getCacheKey(members, options);
    if (this.cache && this.cacheKey === cacheKey) {
      return this.cache;
    }

    const {
      mode = 'recent',        // Slicing strategy
      windowSize = 1000,      // Max members to show at once
      currentDate = new Date(), // Reference date
      windowDays = 30,        // Time window in days
      cohortId = null,        // Specific cohort to show
      activityThreshold = 7   // Days since last activity
    } = options;

    this.sliceMode = mode;

    let result;
    switch (mode) {
      case 'recent':
        result = this.sliceRecent(members, windowSize);
        break;

      case 'date-range':
        result = this.sliceDateRange(members, currentDate, windowDays, windowSize);
        break;

      case 'cohort':
        result = this.sliceCohort(members, cohortId, windowSize);
        break;

      case 'activity':
        result = this.sliceByActivity(members, activityThreshold, windowSize);
        break;

      case 'paginated':
        result = this.slicePaginated(members, options.page || 0, windowSize);
        break;

      default:
        result = this.sliceRecent(members, windowSize);
    }

    // Cache the result
    this.cache = result;
    this.cacheKey = cacheKey;
    this.cacheTimestamp = Date.now();

    return result;
  }

  /**
   * Show most recently joined/updated members
   */
  sliceRecent(members, maxCount) {
    // Get all members as array
    const memberArray = Array.from(members.entries());

    // Check if members have date fields (support both createdAt/created)
    const hasDateFields = memberArray.some(([id, m]) => m.createdAt || m.updatedAt || m.created || m.updated);

    if (hasDateFields) {
      // Sort by date fields, take most recent N
      // Support both naming conventions: createdAt/created, updatedAt/updated
      const sorted = memberArray
        .filter(([id, m]) => m.createdAt || m.updatedAt || m.created || m.updated)
        .sort((a, b) => {
          const dateA = new Date(a[1].updatedAt || a[1].updated || a[1].createdAt || a[1].created);
          const dateB = new Date(b[1].updatedAt || b[1].updated || b[1].createdAt || b[1].created);
          return dateB - dateA; // Most recent first
        })
        .slice(0, maxCount);

      return new Map(sorted);
    } else {
      // Fallback: just take first N members (no sorting)
      // This handles cases where members don't have date fields
      const slice = memberArray.slice(0, maxCount);
      return new Map(slice);
    }
  }

  /**
   * Show members within a specific date range
   */
  sliceDateRange(members, centerDate, windowDays, maxCount) {
    const centerTime = centerDate.getTime();
    const halfWindow = windowDays * 24 * 60 * 60 * 1000 / 2;
    const startTime = centerTime - halfWindow;
    const endTime = centerTime + halfWindow;

    const filtered = Array.from(members.entries())
      .filter(([id, m]) => {
        const date = new Date(m.createdAt || m.updatedAt);
        const time = date.getTime();
        return time >= startTime && time <= endTime;
      })
      .slice(0, maxCount);

    return new Map(filtered);
  }

  /**
   * Show members from a specific cohort (e.g., "March 2024 joiners")
   */
  sliceCohort(members, cohortId, maxCount) {
    if (!cohortId) return new Map();

    // Example: cohortId = "2024-03" for March 2024 cohort
    const filtered = Array.from(members.entries())
      .filter(([id, m]) => {
        const date = new Date(m.createdAt || m.updatedAt);
        const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        return yearMonth === cohortId;
      })
      .slice(0, maxCount);

    return new Map(filtered);
  }

  /**
   * Show members active within last N days
   */
  sliceByActivity(members, daysThreshold, maxCount) {
    const now = Date.now();
    const threshold = daysThreshold * 24 * 60 * 60 * 1000;

    const filtered = Array.from(members.entries())
      .filter(([id, m]) => {
        const lastActive = new Date(m.updatedAt || m.createdAt);
        return (now - lastActive.getTime()) <= threshold;
      })
      .sort((a, b) => {
        const dateA = new Date(a[1].updatedAt || a[1].createdAt);
        const dateB = new Date(b[1].updatedAt || b[1].createdAt);
        return dateB - dateA;
      })
      .slice(0, maxCount);

    return new Map(filtered);
  }

  /**
   * Paginated slicing - show page N of members
   */
  slicePaginated(members, page, pageSize) {
    const sorted = Array.from(members.entries())
      .sort((a, b) => {
        const dateA = new Date(a[1].createdAt || a[1].updatedAt || 0);
        const dateB = new Date(b[1].createdAt || b[1].updatedAt || 0);
        return dateB - dateA;
      });

    const start = page * pageSize;
    const end = start + pageSize;
    const slice = sorted.slice(start, end);

    return new Map(slice);
  }

  /**
   * Get metadata about current slice
   */
  getSliceInfo(allMembers, slicedMembers) {
    return {
      total: allMembers.size,
      visible: slicedMembers.size,
      percentage: Math.round((slicedMembers.size / allMembers.size) * 100),
      mode: this.sliceMode
    };
  }

  /**
   * Navigate to next time window
   */
  nextSlice(members, currentOptions) {
    if (currentOptions.mode === 'paginated') {
      return { ...currentOptions, page: (currentOptions.page || 0) + 1 };
    }
    if (currentOptions.mode === 'date-range') {
      const newDate = new Date(currentOptions.currentDate);
      newDate.setDate(newDate.getDate() + currentOptions.windowDays);
      return { ...currentOptions, currentDate: newDate };
    }
    return currentOptions;
  }

  /**
   * Navigate to previous time window
   */
  previousSlice(members, currentOptions) {
    if (currentOptions.mode === 'paginated') {
      return { ...currentOptions, page: Math.max(0, (currentOptions.page || 0) - 1) };
    }
    if (currentOptions.mode === 'date-range') {
      const newDate = new Date(currentOptions.currentDate);
      newDate.setDate(newDate.getDate() - currentOptions.windowDays);
      return { ...currentOptions, currentDate: newDate };
    }
    return currentOptions;
  }
}
