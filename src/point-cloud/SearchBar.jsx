/**
 * Search input + dropdown. Same structure as test-point-cloud.html #search.
 * Script uses #search input and #search-dropdown; handlers on window from scene init.
 */
export function SearchBar() {
  return (
    <div id="search">
      <input
        type="text"
        placeholder="Search by username..."
        aria-label="Search by username"
        onKeyUp={(e) => window.searchMember?.(e)}
        onFocus={() => window.showSearchDropdown?.()}
      />
      <div id="search-dropdown">
        {/* Search results populated by scene script */}
      </div>
    </div>
  );
}
