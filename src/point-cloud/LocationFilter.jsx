/**
 * Location filter: region, city, country. Hides points that don't match.
 * Uses window.getLocationFilterOptions() and window.setLocationFilter() from pointCloudScene.
 * Dropdown options are seeded from static data (pre-fetched from Back4App) so they
 * appear immediately, then merged with any dynamically loaded options.
 */
import { useState } from 'react';

/** Static location data pre-fetched from Back4App (10k members sampled, deduplicated). */
const STATIC_COUNTRIES = [
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
  'Tanzania','Thailand','Trinidad and Tobago','T\u00fcrkiye','Ukraine',
  'United Arab Emirates','United Kingdom','United States','Venezuela','Vietnam',
  'Zambia','Zimbabwe',
];

const STATIC_REGIONS = [
  'Abia State','Addis Ababa','Aguadilla','Aguascalientes','Alabama',
  'Alajuela Province','Alaska','Alberta','Amhara','Andalusia','Ankara','Antalya',
  'Antioquia','Anzo\u00e1tegui','Apure','Aragon','Aragua','Arizona','Arkansas',
  'Ashanti Region','Atl\u00e1ntico','Attica','Auckland','Australian Capital Territory',
  'Baden-Wurttemberg','Baghdad','Bagmati Province','Bahia','Baja California',
  'Baja California Sur','Balad\u012byat ad Daw\u1e29ah','Balearic Islands','Barinas',
  'Basilicate','Basque Country','Bavaria','Bay of Plenty','Belize District','Bern',
  'Bihor County','Bogota D.C.','Bol\u00edvar','Bratislava Region','Brazzaville',
  'British Columbia','Brittany','Brussels Capital','Bucure\u0219ti','Budapest',
  'Buenos Aires','Buenos Aires F.D.','Calabarzon','Caldas Department','California',
  'Campeche','Canary Islands','Canterbury','Capital Region','Carabobo',
  'Castille and Le\u00f3n','Castille-La Mancha','Catalonia','Cauca Department',
  'Central District','Central Greece','Central Region','Cesar Department',
  'Chaguanas','Chiapas','Chihuahua','Chubut','City of Zagreb','Coahuila',
  'Cojedes','Colorado','Connacht','Connecticut','Cordillera','Cordoba',
  'Corrientes','Couva-Tabaquite-Talparo','Cundinamarca','Dar es Salaam Region',
  'Davao Region','Dededo','Delaware','Departamento de Bol\u00edvar',
  'Departamento de Boyac\u00e1','Departamento del Cauca','Departamento del Choc\u00f3',
  'District of Columbia','Distrito Federal','Durango','East','Eastern Cape',
  'Emilia-Romagna','England','Entre Rios','Estado Trujillo','Falc\u00f3n',
  'Federation of Bosnia and Herzegovina','Flanders','Florida','Formosa',
  'Francisco Moraz\u00e1n Department','Free State','Gaborone','Galicia','Gauteng',
  'Georgia','Gharbia','Giza','Goi\u00e1s','Guanajuato','Guerrero','Gu\u00e1rico',
  'Hamburg','Harare','Harjumaa','Hawaii',"Hawke's Bay Region",'Hesse','Hidalgo',
  'Ho Chi Minh','Idaho','Illinois','Indiana','Iowa','Islamabad','Istanbul',
  'Jalisco','Jujuy','Kaafu Atoll','Kansas','Karnataka','Kentucky','Kerala',
  'Kingston','Koshi','Krabi','KwaZulu-Natal','Kwai Tsing District','La Rioja',
  'Lagos','Lara','Lazio','Leinster','Libereck\u00fd kraj','Lima region',
  'Limassol District','Limpopo','Lisbon','Ljubljana','Lombardy','Louisiana',
  'Lower Saxony','Lower Silesia','Lusaka Province','Lvivska Oblast','Madrid',
  'Maharashtra','Maine','Manawatu-Wanganui','Manitoba','Manzini Region',
  'Maryland','Massachusetts','Melilla','Mendoza','Metro Manila','Mexico City',
  'Michigan','Michoac\u00e1n','Minnesota','Miranda','Misiones','Mississippi','Missouri',
  'Monagas','Montana','Morelos','Mpumalanga','Munster','Murcia','M\u00e9rida','M\u00e9xico',
  'Nagaland','Nairobi County','Nari\u00f1o','National Capital Territory of Delhi',
  'Navarre','Nayarit','Nebraska','Neuquen','Nevada','New Brunswick',
  'New Hampshire','New Jersey','New Mexico','New South Wales','New York',
  'Newfoundland and Labrador','Nitra Region','Norte de Santander Department',
  'North Carolina','North Dakota','North Holland','North Rhine-Westphalia',
  'North West','Northern Cape','Northern Ireland','Northern Territory','Northland',
  'Northwest Territories','Nova Scotia','Nueva Esparta','Nuevo Le\u00f3n','Nunavut',
  'Oaxaca','Ohio','Oklahoma','Ontario','Oregon','Otago','Overijssel',
  'Paramaribo District','Pavlodar Region','Pennsylvania','Phuket','Pichincha',
  'Port of Spain','Portuguesa','Prague','Primorje-Gorski Kotar County',
  'Prince Edward Island','Principality of Asturias','Provincia de San Jos\u00e9',
  'Puebla','Punjab','Quebec','Queensland','Quer\u00e9taro','Quintana Roo','Rajasthan',
  'Razavi Khorasan','Rheinland-Pfalz','Rhode Island','Rio Negro','Rivers State',
  'Roraima','R\u012bga','Salta','San Juan','San Luis','San Luis Potos\u00ed',
  'San Salvador Department','Santa Cruz','Santa Cruz Department','Santa Fe',
  'Santander Department','Santiago Metropolitan','Santiago del Estero',
  'Saskatchewan','Saxony','Scotland','Selangor','Silesia','Sinaloa','Sindh',
  'Skikda','Sonora','South Australia','South Carolina','South Dakota',
  'South Holland','South Ostrobothnia','Southern Region','Southwest Finland',
  'State of Berlin','Stockholm County','Sucre','S\u00e3o Paulo','Tabasco','Tamaulipas',
  'Tamil Nadu','Tasman District','Tasmania','Tehran','Tel Aviv','Telangana',
  'Tennessee','Texas','Tlaxcala','Tokyo','Tolima Department','Tucuman','T\u00e1chira',
  'Ulaanbaatar','Ulster','Utah','Uttarakhand','Uusimaa','Valencia',
  'Valle del Cauca Department','Vargas','Veracruz','Vermont','Victoria','Vienna',
  'Vilnius','Virginia','Vukovar-Srijem County','V\u00e4rmland County',
  'V\u00e4stra G\u00f6taland County','Waikato Region','Wales','Washington',
  'Wellington Region','West Virginia','Western Australia','Western Cape',
  'Wisconsin','Wyoming','Yaracuy','Yucat\u00e1n','Yukon','Zacatecas','Zulia','Zurich',
  '\u00cele-de-France',
];

const STATIC_CITIES = [
  'Acme','Albany','Albuquerque','Allen Park','Anaheim','Andover','Arlington',
  'Athens','Atlanta','Auckland','Bagillt','Bakersfield','Bangkok','Baton Rouge',
  'Bel Air','Boca Raton','Boston','Bremerton','Brentwood','Brighton','Brooklyn',
  'Browns Mills','Buford','Burlington','Burwell','Calgary','Camden',
  'Castilleja de Guzm\u00e1n','Castle Rock','Chambersburg','Charlotte','Cheltenham',
  'Chesterland','Chicago','Christchurch','Clute','Columbus','Commack','Concord',
  'Conroe','Coquitlam','Corinth','Cornwall','Coventry','Cypress','Dacula',
  'Dallas','Dar es Salaam','Denver','Des Plaines','Dilley','Dobson','Douglas',
  'Doylestown','Drums','Dulles','Durham','Easley','East Hartford','East Windsor',
  'Edmonton','El Cajon','El Paso','El Sobrante','Elmsford','Ennis','Esparto',
  'Eugene','Fairbanks','Fairfax','Falls Church','Fargo','Flint','Forden','Forest',
  'Fort Worth','Fresno','Galena','Gastonia','Georgetown','Glasgow','Glastonbury',
  'Gloucester City','Golden','Grand Rapids','Grants Pass','Greenwood Village',
  'Hanover','Harlan','Harrisonburg','Harrisville','Hartford','Hartland','Hemet',
  'Highland','Hilliard','Houston','Hudson','Indianapolis','Kansas City','Lagos',
  'Lanark','Lancaster','Lansing','Las Vegas','Lawrenceville','Lebanon','Leeds',
  'Littleton','Liverpool','Londonderry','Los Altos','Los Angeles','Louisville',
  'Lubbock','Lynnwood','Macedon','Manassas','Manchester','Market Harborough',
  'Martinsburg','Melbourne','Memphis','Miami','Middletown','Milton','Milwaukee',
  'Minneapolis','Missoula','Mobile','Montreal','Morristown','Murfreesboro',
  'New York','Newburgh','Newcastle upon Tyne','Newport Beach','Newton Aycliffe',
  'Norfolk','North Las Vegas','North Royalton','Oakland','Oklahoma City',
  'Orland Park','Orlando','Overland Park','Oxford','Oxnard','Palm Coast',
  'Palmerton','Panama City','Pasco','Philadelphia','Phoenix','Pinckney',
  'Pittsburgh','Plattsburgh','Portland','Portsmouth','Pueblo','Queens','Quincy',
  'Raleigh','Regina','Rhododendron','Richmond','Riverside','Roanoke','Royse City',
  'Salem','Salisbury','San Antonio','San Bernardino','San Francisco','Santa Rosa',
  'Santee','Seattle','Sharjah','Sheffield','Simpsonville','Singapore','Somerville',
  'Southampton','Southwark','Spring Valley','Springfield','St Louis','Stafford',
  'Sunderland','Swansea','Sydney','Tampa','Tavares','Tempe','Tempe Junction',
  'The Bronx','Thornton','Toronto','Tucson','Vancouver','Vero Beach',
  'Virginia Beach','Washington','Waterbury','West Chester','Willimantic',
  'Wilmington','Winnipeg','Woodland Hills','Worcester','Youngstown',
];

const STATIC = {
  countries: STATIC_COUNTRIES,
  regions: STATIC_REGIONS,
  cities: STATIC_CITIES,
};

/** Merge static + dynamic arrays, deduplicate, sort. */
function mergeOptions(staticOpts, dynamicOpts) {
  return {
    countries: [...new Set([...staticOpts.countries, ...dynamicOpts.countries])].sort(),
    regions: [...new Set([...staticOpts.regions, ...dynamicOpts.regions])].sort(),
    cities: [...new Set([...staticOpts.cities, ...dynamicOpts.cities])].sort(),
  };
}

export function LocationFilter() {
  const [expanded, setExpanded] = useState(false);
  const [country, setCountry] = useState('');
  const [region, setRegion] = useState('');
  const [city, setCity] = useState('');

  // Compute options on every render: static data is always available,
  // dynamic data merges in once the scene has loaded location info.
  const dynamic = (typeof window.getLocationFilterOptions === 'function')
    ? (window.getLocationFilterOptions() || { countries: [], regions: [], cities: [] })
    : { countries: [], regions: [], cities: [] };
  const options = mergeOptions(STATIC, dynamic);

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
