const STATE = (() => {
  try { return localStorage.getItem('ha.state') || 'ut'; } catch (e) { return 'ut'; }
})();
