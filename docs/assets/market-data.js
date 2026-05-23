window.TRADING_ASSISTANT_MARKET_DATA = {
  updatedAt: "2026-05-23",
  calendarBasis:
    "Official NYSE/Nasdaq 2026-2028 holiday and early-close schedule, with rule-based fallback for later years.",
  officialSchedule: {
    "2026-01-01": { type: "closed", label: "New Year's Day", source: "NYSE/Nasdaq official 2026" },
    "2026-01-19": { type: "closed", label: "Martin Luther King, Jr. Day", source: "NYSE/Nasdaq official 2026" },
    "2026-02-16": { type: "closed", label: "Washington's Birthday", source: "NYSE/Nasdaq official 2026" },
    "2026-04-03": { type: "closed", label: "Good Friday", source: "NYSE/Nasdaq official 2026" },
    "2026-05-25": { type: "closed", label: "Memorial Day", source: "NYSE/Nasdaq official 2026" },
    "2026-06-19": { type: "closed", label: "Juneteenth National Independence Day", source: "NYSE/Nasdaq official 2026" },
    "2026-07-03": { type: "closed", label: "Independence Day observed", source: "NYSE/Nasdaq official 2026" },
    "2026-09-07": { type: "closed", label: "Labor Day", source: "NYSE/Nasdaq official 2026" },
    "2026-11-26": { type: "closed", label: "Thanksgiving Day", source: "NYSE/Nasdaq official 2026" },
    "2026-11-27": { type: "early", label: "Day after Thanksgiving", close: "13:00", source: "NYSE official early close" },
    "2026-12-24": { type: "early", label: "Christmas Eve", close: "13:00", source: "NYSE official early close" },
    "2026-12-25": { type: "closed", label: "Christmas Day", source: "NYSE/Nasdaq official 2026" },

    "2027-01-01": { type: "closed", label: "New Year's Day", source: "NYSE official 2027" },
    "2027-01-18": { type: "closed", label: "Martin Luther King, Jr. Day", source: "NYSE official 2027" },
    "2027-02-15": { type: "closed", label: "Washington's Birthday", source: "NYSE official 2027" },
    "2027-03-26": { type: "closed", label: "Good Friday", source: "NYSE official 2027" },
    "2027-05-31": { type: "closed", label: "Memorial Day", source: "NYSE official 2027" },
    "2027-06-18": { type: "closed", label: "Juneteenth National Independence Day observed", source: "NYSE official 2027" },
    "2027-07-05": { type: "closed", label: "Independence Day observed", source: "NYSE official 2027" },
    "2027-09-06": { type: "closed", label: "Labor Day", source: "NYSE official 2027" },
    "2027-11-25": { type: "closed", label: "Thanksgiving Day", source: "NYSE official 2027" },
    "2027-11-26": { type: "early", label: "Day after Thanksgiving", close: "13:00", source: "NYSE official early close" },
    "2027-12-24": { type: "closed", label: "Christmas Day observed", source: "NYSE official 2027" },

    "2028-01-17": { type: "closed", label: "Martin Luther King, Jr. Day", source: "NYSE official 2028" },
    "2028-02-21": { type: "closed", label: "Washington's Birthday", source: "NYSE official 2028" },
    "2028-04-14": { type: "closed", label: "Good Friday", source: "NYSE official 2028" },
    "2028-05-29": { type: "closed", label: "Memorial Day", source: "NYSE official 2028" },
    "2028-06-19": { type: "closed", label: "Juneteenth National Independence Day", source: "NYSE official 2028" },
    "2028-07-03": { type: "early", label: "Day before Independence Day", close: "13:00", source: "NYSE official early close" },
    "2028-07-04": { type: "closed", label: "Independence Day", source: "NYSE official 2028" },
    "2028-09-04": { type: "closed", label: "Labor Day", source: "NYSE official 2028" },
    "2028-11-23": { type: "closed", label: "Thanksgiving Day", source: "NYSE official 2028" },
    "2028-11-24": { type: "early", label: "Day after Thanksgiving", close: "13:00", source: "NYSE official early close" },
    "2028-12-25": { type: "closed", label: "Christmas Day", source: "NYSE official 2028" }
  },
  researchNotes: [
    {
      title: "Core session is the main liquidity window",
      note:
        "NYSE and Nasdaq regular stock-market hours are 9:30 a.m. to 4:00 p.m. ET. Extended hours can be useful, but should be treated as lower-confidence execution.",
      source: "NYSE/Nasdaq trading hours"
    },
    {
      title: "Extended hours carry execution risk",
      note:
        "SEC warns that after-hours markets may have lower volume, wider spreads, more volatility, and uncertain prices. The assistant marks premarket/after-hours as lower confidence by default.",
      source: "SEC after-hours risk publication"
    },
    {
      title: "Crash mode should be mechanical",
      note:
        "NYSE market-wide circuit breakers use S&P 500 single-day declines of 7%, 13%, and 20%. The app turns that into a no-hero-trade checklist.",
      source: "NYSE MWCB FAQ"
    },
    {
      title: "November-April has historical seasonality, not a guarantee",
      note:
        "A broad academic study found average returns higher in November-April than May-October across many markets. This is a regime hint, not a reason to override price action.",
      source: "Jacobsen and Zhang, Journal of International Money and Finance"
    },
    {
      title: "Year-end is not simply bearish",
      note:
        "November-December can combine seasonal strength, tax-loss selling, window dressing, rebalancing, holiday closures, and thin sessions. The app treats this as position-size and execution-risk context.",
      source: "Synthesis from official calendars and seasonality literature"
    }
  ],
  sources: [
    {
      label: "NYSE Holidays and Trading Hours",
      url: "https://www.nyse.com/trade/hours-calendars"
    },
    {
      label: "Nasdaq Stock Market Holiday Schedule",
      url: "https://www.nasdaq.com/market-activity/stock-market-holiday-schedule"
    },
    {
      label: "SEC After-Hours Trading Risks",
      url: "https://www.sec.gov/about/reports-publications/investorpubsafterhourshtm"
    },
    {
      label: "NYSE Market-Wide Circuit Breakers FAQ",
      url: "https://www.nyse.com/publicdocs/nyse/NYSE_MWCB_FAQ.pdf"
    },
    {
      label: "The Halloween Indicator, Sell in May and Go Away",
      url: "https://www.sciencedirect.com/science/article/abs/pii/S0261560620302242"
    }
  ]
};
