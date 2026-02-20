/**
 * Location filter: region, city, country. Hides points that don't match.
 * Uses window.getLocationFilterOptions() and window.setLocationFilter() from pointCloudScene.
 */
import { useState, useEffect } from 'react';

const EMPTY = { countries: [], regions: [], cities: [] };

export function LocationFilter() {
  const [expanded, setExpanded] = useState(false);
  const [options, setOptions] = useState(EMPTY);
  const [country, setCountry] = useState('');
  const [region, setRegion] = useState('');
  const [city, setCity] = useState('');

  useEffect(() => {
    if (expanded && typeof window.getLocationFilterOptions === 'function') {
      setOptions(window.getLocationFilterOptions() || EMPTY);
    }
  }, [expanded]);

  const apply = (c, r, ci) => {
    if (typeof window.setLocationFilter === 'function') {
      window.setLocationFilter({ country: c, region: r, city: ci });
    }
  };

  const handleCountry = (e) => {
    const v = e.target.value || '';
    setCountry(v);
    apply(v, region, city);
  };

  const handleRegion = (e) => {
    const v = e.target.value || '';
    setRegion(v);
    apply(country, v, city);
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
    if (typeof window.setLocationFilter === 'function') {
      window.setLocationFilter({ country: '', region: '', city: '' });
    }
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
      </button>
      {expanded && (
        <div id="location-filter-panel" className="location-filter-panel" role="region" aria-label="Location filters">
          <label className="location-filter-label">
            Country
            <select value={country} onChange={handleCountry} aria-label="Filter by country">
              <option value="">All</option>
              {options.countries.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="location-filter-label">
            Region
            <select value={region} onChange={handleRegion} aria-label="Filter by region">
              <option value="">All</option>
              {options.regions.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="location-filter-label">
            City
            <select value={city} onChange={handleCity} aria-label="Filter by city">
              <option value="">All</option>
              {options.cities.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
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
