/**
 * Cascading location filter: Country → Region/State → City.
 *
 * Options are built dynamically from loaded members so the dropdowns only
 * show locations that actually exist in the dataset. Selecting a country
 * narrows the available regions; selecting a region narrows the available
 * cities. Clearing a parent level also clears its children.
 *
 * Static fallback lists (from locationData.js) are merged with live data
 * so the UI is usable even before the first back4app feed completes.
 */
import { useState, useMemo } from 'react';
import { useUniverseStore } from '../stores/universeStore';
import { memberMatchesLocationFilter, normalizeRegion } from '../../lib/codec.js';
import { STATIC_COUNTRIES, STATIC_REGIONS, STATIC_CITIES } from './locationData.js';

/**
 * Scan all loaded members and build location option maps.
 * Returns { countries, regionsByCountry, citiesByCountryRegion }.
 */
function buildLocationIndex(members) {
  // country → Set<region>
  const regionsByCountry = new Map();
  // "country|region" → Set<city>
  const citiesByCountryRegion = new Map();
  // All unique values
  const countries = new Set();

  members.forEach((m) => {
    const co = (m.country || '').trim();
    const rg = (m.region || m.state || '').trim();
    const ci = (m.city || '').trim();

    if (co) {
      countries.add(co);
      if (!regionsByCountry.has(co)) regionsByCountry.set(co, new Set());
      if (rg) regionsByCountry.get(co).add(rg);
    }

    const regionKey = `${co}|${rg}`;
    if (!citiesByCountryRegion.has(regionKey)) citiesByCountryRegion.set(regionKey, new Set());
    if (ci) citiesByCountryRegion.get(regionKey).add(ci);
  });

  return { countries, regionsByCountry, citiesByCountryRegion };
}

/**
 * Get the count of members matching a partial filter.
 */
function countMatching(members, filter) {
  let n = 0;
  members.forEach((m) => {
    if (memberMatchesLocationFilter(m, filter)) n++;
  });
  return n;
}

export function LocationFilter() {
  const [expanded, setExpanded] = useState(false);
  const [country, setCountry] = useState('');
  const [region, setRegion] = useState('');
  const [city, setCity] = useState('');
  const storeSetFilter = useUniverseStore((s) => s.setLocationFilter);
  const members = useUniverseStore((s) => s.members);
  const version = useUniverseStore((s) => s.version);

  // Build location index from loaded members (re-computed when version changes)
  const locationIndex = useMemo(() => {
    return buildLocationIndex(members);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, version]);

  // --- Cascading options ---

  // Countries: merge live data with static fallback, sorted
  const countryOptions = useMemo(() => {
    const set = new Set([...locationIndex.countries, ...STATIC_COUNTRIES]);
    return [...set].sort();
  }, [locationIndex]);

  // Regions: if a country is selected, only show regions for that country.
  // Otherwise show all known regions.
  const regionOptions = useMemo(() => {
    if (country) {
      const liveRegions = locationIndex.regionsByCountry.get(country);
      const regions = liveRegions ? [...liveRegions] : [];
      // Also include static regions that conceptually belong to this country
      // (e.g., US states when "United States" is selected)
      STATIC_REGIONS.forEach((r) => {
        // Check if any member in this country has this region
        if (!regions.includes(r)) {
          const norm = normalizeRegion(r);
          const liveNorms = regions.map(normalizeRegion);
          if (!liveNorms.includes(norm)) {
            // Only add if at least one member has this region+country combo
            // Skip to avoid showing irrelevant static entries
          }
        }
      });
      return regions.sort();
    }
    const set = new Set();
    locationIndex.regionsByCountry.forEach((regions) => {
      regions.forEach((r) => set.add(r));
    });
    STATIC_REGIONS.forEach((r) => set.add(r));
    return [...set].sort();
  }, [country, locationIndex]);

  // Cities: if country/region selected, only show cities for that scope.
  const cityOptions = useMemo(() => {
    if (country || region) {
      const cities = new Set();
      locationIndex.citiesByCountryRegion.forEach((citySet, key) => {
        const [co, rg] = key.split('|');
        if (country && co !== country) return;
        if (region && normalizeRegion(rg) !== normalizeRegion(region)) return;
        citySet.forEach((c) => cities.add(c));
      });
      return [...cities].sort();
    }
    const set = new Set();
    locationIndex.citiesByCountryRegion.forEach((citySet) => {
      citySet.forEach((c) => set.add(c));
    });
    STATIC_CITIES.forEach((c) => set.add(c));
    return [...set].sort();
  }, [country, region, locationIndex]);

  // Count of members matching current filter
  const matchCount = useMemo(() => {
    const hasFilter = country || region || city;
    if (!hasFilter || members.size === 0) return null;
    return countMatching(members, { country, region, city });
  }, [country, region, city, members, version]);

  const apply = (c, r, ci) => {
    const filter = { country: c, region: r, city: ci };
    storeSetFilter(filter);
    if (typeof window.setLocationFilter === 'function') {
      window.setLocationFilter(filter);
    }
  };

  const handleCountry = (e) => {
    const v = e.target.value || '';
    setCountry(v);
    // Clear child selections when parent changes
    setRegion('');
    setCity('');
    apply(v, '', '');
  };

  const handleRegion = (e) => {
    const v = e.target.value || '';
    setRegion(v);
    // Clear city when region changes
    setCity('');
    apply(country, v, '');
  };

  const handleCity = (e) => {
    const v = e.target.value || '';
    setCity(v);
    apply(country, region, v);
  };

  const clearFilters = () => {
    setCountry('');
    setRegion('');
    setCity('');
    apply('', '', '');
  };

  const hasFilter = country || region || city;

  return (
    <div id="location-filter" className="location-filter">
      <button
        type="button"
        className="location-filter-toggle"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls="location-filter-panel"
      >
        Filter by location
        {hasFilter && <span className="location-filter-badge"> on</span>}
        {hasFilter && matchCount !== null && (
          <span className="location-filter-count"> ({matchCount})</span>
        )}
      </button>
      {expanded && (
        <div id="location-filter-panel" className="location-filter-panel" role="region" aria-label="Location filters">
          <label className="location-filter-label">
            Country
            <select value={country} onChange={handleCountry} aria-label="Filter by country">
              <option value="">All</option>
              {countryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="location-filter-label">
            Region / State
            <select value={region} onChange={handleRegion} aria-label="Filter by region">
              <option value="">All</option>
              {regionOptions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="location-filter-label">
            City
            <select value={city} onChange={handleCity} aria-label="Filter by city">
              <option value="">All</option>
              {cityOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {hasFilter && (
            <button type="button" className="location-filter-clear" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
