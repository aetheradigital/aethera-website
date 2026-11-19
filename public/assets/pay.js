/* Shared helpers for the Aethera payment pages: config, Stripe instance, branded Payment Element. */
(function () {
  var cfgPromise = null;

  function config() {
    if (!cfgPromise) {
      cfgPromise = fetch('/api/config', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
        .catch(function () { return { enabled: false }; });
    }
    return cfgPromise;
  }

  // Matches the site: black surfaces, lavender accent, Avenir/Nunito Sans body, soft rounded fields.
  var appearance = {
    theme: 'night',
    labels: 'above',
    variables: {
      colorPrimary: '#C8B6FF',
      colorBackground: '#121217',
      colorText: '#FFFFFF',
      colorTextSecondary: '#A3A3AD',
      colorTextPlaceholder: '#6E6E79',
      colorDanger: '#FFB3B3',
      colorSuccess: '#CFE8B4',
      colorIcon: '#A3A3AD',
      fontFamily: '"Avenir Next", Avenir, "Nunito Sans", system-ui, sans-serif',
      fontSizeBase: '16px',
      fontWeightNormal: '400',
      fontWeightMedium: '600',
      borderRadius: '14px',
      spacingUnit: '4px',
      gridRowSpacing: '18px',
      gridColumnSpacing: '14px',
      focusBoxShadow: '0 0 0 3px rgba(200,182,255,.28)',
      focusOutline: 'none'
    },
    rules: {
      '.Label': { fontSize: '12px', letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: '600', color: '#A3A3AD', marginBottom: '8px' },
      '.Input': { backgroundColor: '#121217', border: '1px solid rgba(255,255,255,0.16)', boxShadow: 'none', padding: '14px 16px' },
      '.Input:hover': { borderColor: 'rgba(255,255,255,0.3)' },
      '.Input:focus': { borderColor: '#C8B6FF', boxShadow: '0 0 0 3px rgba(200,182,255,.28)' },
      '.Input--invalid': { borderColor: '#FFB3B3', boxShadow: 'none' },
      '.Tab': { backgroundColor: '#121217', border: '1px solid rgba(255,255,255,0.16)', boxShadow: 'none', padding: '14px 16px' },
      '.Tab:hover': { borderColor: 'rgba(255,255,255,0.3)', color: '#FFFFFF' },
      '.Tab--selected, .Tab--selected:hover, .Tab--selected:focus': { backgroundColor: '#1A1724', borderColor: '#C8B6FF', boxShadow: '0 0 0 1px #C8B6FF', color: '#FFFFFF' },
      '.TabIcon--selected': { fill: '#C8B6FF' },
      '.TabLabel': { fontWeight: '600' },
      '.Block': { backgroundColor: '#121217', border: '1px solid rgba(255,255,255,0.16)', boxShadow: 'none' },
      '.Error': { fontSize: '14px' }
    }
  };
  var fonts = [{ cssSrc: 'https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;600;700&display=swap' }];

  function money(cents, currency) {
    if (typeof cents !== 'number') return '';
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: String(currency || 'usd').toUpperCase() });
  }

  // Mount a Payment Element. opts: { mount, clientSecret } or deferred { mount, mode, amount, currency, paymentMethodTypes }.
  function mountPayment(stripe, opts) {
    var elementsOpts = { appearance: appearance, fonts: fonts, loader: 'never' };
    if (opts.clientSecret) elementsOpts.clientSecret = opts.clientSecret;
    else {
      elementsOpts.mode = opts.mode; elementsOpts.amount = opts.amount; elementsOpts.currency = opts.currency || 'usd';
      elementsOpts.allowedPaymentMethodTypes = opts.paymentMethodTypes;
    }
    var elements = stripe.elements(elementsOpts);
    var pe = elements.create('payment', {
      layout: { type: 'tabs', defaultCollapsed: false },
      business: { name: 'Aethera Digital' },
      fields: { billingDetails: { email: opts.email ? 'never' : 'auto', name: opts.name ? 'never' : 'auto' } }
    });
    pe.mount(opts.mount);
    return { elements: elements, element: pe };
  }

  window.AetheraPay = { config: config, appearance: appearance, money: money, mountPayment: mountPayment };
})();
