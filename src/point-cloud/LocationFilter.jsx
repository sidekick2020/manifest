/**
 * Location filter: region, city, country. Hides points that don't match.
 */
import { useState } from 'react';
import { useUniverseStore } from '../stores/universeStore';

const COUNTRIES = [
  'Algeria','Argentina','Australia','Austria','Belgium','Belize','Bolivia',
  'Bosnia and Herzegovina','Botswana','Brazil','Canada','Chile','Colombia',
  'Congo Republic','Costa Rica','Croatia','Curacao','Cyprus','Czechia','Denmark',
  'Ecuador','Egypt','El Salvador','Estonia','Eswatini','Ethiopia','Finland',
  'France','Germany','Ghana','Greece','Guam','Honduras','Hong Kong','Hungary',
  'Iceland','India','Iran','Iraq','Ireland','Israel','Italy','Jamaica','Japan',
  'Kazakhstan','Kenya','Latvia','Lithuania','Malawi','Malaysia','Maldives',
  'Mexico','Mongolia','Nepal','Netherlands','New Zealand','Nigeria','Pakistan',
  'Peru','Philippines','Poland','Portugal','Puerto Rico','Qatar','Romania',
  'Slovakia','Slovenia','South Africa','Spain','Suriname','Sweden','Switzerland',
  'Tanzania','Thailand','Trinidad and Tobago','Turkey','Ukraine',
  'United Arab Emirates','United Kingdom','United States','Venezuela','Vietnam',
  'Zambia','Zimbabwe',
];

const REGIONS = [
  'Alabama','Alaska','Alberta','Arizona','Arkansas','California','Colorado',
  'Connecticut','Delaware','District of Columbia','Florida','Georgia','Hawaii',
  'Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine',
  'Manitoba','Maryland','Massachusetts','Michigan','Minnesota','Mississippi',
  'Missouri','Montana','Nebraska','Nevada','New Brunswick','New Hampshire',
  'New Jersey','New Mexico','New York','North Carolina','North Dakota',
  'Newfoundland and Labrador','Nova Scotia','Ohio','Oklahoma','Ontario','Oregon',
  'Pennsylvania','Prince Edward Island','Quebec','Rhode Island','Saskatchewan',
  'South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia',
  'Washington','West Virginia','Wisconsin','Wyoming',
  'British Columbia','Northwest Territories','Nunavut','Yukon',
  'England','Scotland','Wales','Northern Ireland',
  'New South Wales','Queensland','South Australia','Tasmania','Victoria',
  'Western Australia','Northern Territory','Australian Capital Territory',
  'Auckland','Canterbury','Wellington Region','Bay of Plenty','Waikato Region',
  'Andalusia','Catalonia','Madrid','Valencia','Basque Country',
  'Bavaria','Berlin','Hamburg','North Rhine-Westphalia',
  'Ile-de-France','Brittany',
  'Lombardy','Lazio','Emilia-Romagna',
  'Buenos Aires','Cordoba','Santa Fe',
  'Bogota D.C.','Antioquia','Valle del Cauca Department',
  'Mexico City','Jalisco','Nuevo Leon',
  'Sao Paulo','Rio Negro','Bahia',
  'Gauteng','Western Cape','KwaZulu-Natal',
  'Lagos','Rivers State',
  'Nairobi County',
];

const CITIES = [
  'Albuquerque','Anaheim','Arlington','Atlanta','Auckland','Bakersfield',
  'Bangkok','Baton Rouge','Boca Raton','Boston','Brooklyn','Buenos Aires',
  'Calgary','Charlotte','Chicago','Christchurch','Columbus','Dallas','Denver',
  'Durham','Edmonton','El Paso','Eugene','Fairbanks','Fargo','Flint',
  'Fort Worth','Fresno','Glasgow','Grand Rapids','Hartford','Houston',
  'Indianapolis','Kansas City','Lagos','Lancaster','Las Vegas','Leeds',
  'Liverpool','London','Los Angeles','Louisville','Manchester','Melbourne',
  'Memphis','Miami','Milwaukee','Minneapolis','Missoula','Mobile','Montreal',
  'New York','Norfolk','Oakland','Oklahoma City','Orlando','Philadelphia',
  'Phoenix','Pittsburgh','Portland','Raleigh','Regina','Richmond','Salem',
  'San Antonio','San Bernardino','San Francisco','Santa Rosa','Seattle',
  'Sheffield','Singapore','Springfield','St Louis','Sydney','Tampa','Toronto',
  'Tucson','Vancouver','Virginia Beach','Washington','Wilmington','Winnipeg',
];

export function LocationFilter() {
  const [expanded, setExpanded] = useState(false);
  const [country, setCountry] = useState('');
  const [region, setRegion] = useState('');
  const [city, setCity] = useState('');
  const storeSetFilter = useUniverseStore((s) => s.setLocationFilter);

  const apply = (c, r, ci) => {
    const filter = { country: c, region: r, city: ci };
    storeSetFilter(filter);
    if (typeof window.setLocationFilter === 'function') {
      window.setLocationFilter(filter);
    }
  };

  const handleCountry = (e) => { const v = e.target.value || ''; setCountry(v); apply(v, region, city); };
  const handleRegion = (e) => { const v = e.target.value || ''; setRegion(v); apply(country, v, city); };
  const handleCity = (e) => { const v = e.target.value || ''; setCity(v); apply(country, region, v); };

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
      </button>
      {expanded && (
        <div id="location-filter-panel" className="location-filter-panel" role="region" aria-label="Location filters">
          <label className="location-filter-label">
            Country
            <select value={country} onChange={handleCountry} aria-label="Filter by country">
              <option value="">All</option>
              {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="location-filter-label">
            Region / State
            <select value={region} onChange={handleRegion} aria-label="Filter by region">
              <option value="">All</option>
              {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="location-filter-label">
            City
            <select value={city} onChange={handleCity} aria-label="Filter by city">
              <option value="">All</option>
              {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
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
