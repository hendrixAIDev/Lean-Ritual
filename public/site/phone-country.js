// Country calling codes for the phone fields on login.html. Loaded before the page script,
// which uses it when present (and keeps the old single-field behaviour when it is not).
// The server (lib/phone.js) still validates and normalizes every number; this only builds
// "+<code><national number>" from the dropdown and the number field.
(function () {
  "use strict";
  // ISO region -> calling code. Where regions share a code, PRIMARY says which one a typed
  // "+code..." selects. North American Numbering Plan members outside US/CA carry
  // their area code, so "+1 876 ..." selects Jamaica and plain "+1 ..." selects US/Canada.
  var DIAL = ("CN86 US1 HK852 MO853 TW886 SG65 JP81 KR82 GB44 AU61 " +
    "AF93 AX358 AL355 DZ213 AS1684 AD376 AO244 AI1264 AG1268 AR54 AM374 AW297 AT43 AZ994 " +
    "BS1242 BH973 BD880 BB1246 BY375 BE32 BZ501 BJ229 BM1441 BT975 BO591 BQ599 BA387 BW267 BR55 IO246 VG1284 BN673 BG359 BF226 BI257 " +
    "KH855 CM237 CV238 KY1345 CF236 TD235 CL56 CX61 CC61 CO57 KM269 CG242 CD243 CK682 CR506 CI225 HR385 CU53 CW599 CY357 CZ420 " +
    "DK45 DJ253 DM1767 DO1809 DO1829 DO1849 EC593 EG20 SV503 GQ240 ER291 EE372 SZ268 ET251 FK500 FO298 FJ679 FI358 FR33 GF594 PF689 " +
    "GA241 GM220 GE995 DE49 GH233 GI350 GR30 GL299 GD1473 GP590 GU1671 GT502 GG44 GN224 GW245 GY592 HT509 VA39 HN504 HU36 " +
    "IS354 IN91 ID62 IR98 IQ964 IE353 IM44 IL972 IT39 JM1876 JM1658 JE44 JO962 KZ7 KE254 KI686 XK383 KW965 KG996 LA856 LV371 LB961 LS266 LR231 LY218 LI423 LT370 LU352 " +
    "MG261 MW265 MY60 MV960 ML223 MT356 MH692 MQ596 MR222 MU230 YT262 MX52 FM691 MD373 MC377 MN976 ME382 MS1664 MA212 MZ258 MM95 " +
    "NA264 NR674 NP977 NL31 NC687 NZ64 NI505 NE227 NG234 NU683 NF672 KP850 MK389 MP1670 NO47 OM968 " +
    "PK92 PW680 PS970 PA507 PG675 PY595 PE51 PH63 PL48 PT351 PR1787 PR1939 QA974 RE262 RO40 RU7 RW250 " +
    "BL590 SH290 KN1869 LC1758 MF590 PM508 VC1784 WS685 SM378 ST239 SA966 SN221 RS381 SC248 SL232 SX1721 SK421 SI386 SB677 SO252 ZA27 SS211 ES34 LK94 SD249 SR597 SJ47 SE46 CH41 SY963 " +
    "TJ992 TZ255 TH66 TL670 TG228 TK690 TO676 TT1868 TN216 TR90 TM993 TC1649 TV688 VI1340 UG256 UA380 AE971 UY598 UZ998 VU678 VE58 VN84 WF681 EH212 YE967 ZM260 ZW263")
    .split(" ").map(function (s) { return { iso: s.slice(0, 2), dial: s.slice(2) }; });
  var PRIMARY = { "1": "US", "7": "RU", "39": "IT", "44": "GB", "47": "NO", "61": "AU", "212": "MA", "262": "RE", "290": "SH", "358": "FI", "590": "GP", "599": "CW" };
  var COMMON = ["CN", "US", "HK", "MO", "TW", "SG", "JP", "KR", "GB", "AU"];
  // Names Intl.DisplayNames would phrase differently, as the owner asked for them.
  var NAMES = {
    zh: { CN: "中国大陆", US: "美国/加拿大", HK: "香港", MO: "澳门", TW: "台湾" },
    en: { CN: "Mainland China", US: "United States / Canada", HK: "Hong Kong", MO: "Macao", TW: "Taiwan" }
  };
  var EXAMPLES = { CN: "138 0013 8000", US: "415 555 2671", HK: "5123 4567", MO: "6612 3456", TW: "912 345 678", SG: "8123 4567",
    JP: "90 1234 5678", KR: "10 1234 5678", GB: "7400 123456", AU: "412 345 678" };
  // Regions whose national numbers keep their leading 0 after the country code.
  var KEEP_ZERO = { IT: 1, SM: 1, VA: 1, CI: 1 };

  var byIso = {};
  DIAL.forEach(function (e) { if (!byIso[e.iso]) byIso[e.iso] = e.dial; });

  function ascii(raw) {
    return String(raw == null ? "" : raw).replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); }).replace(/＋/g, "+");
  }
  function compact(raw) { return ascii(raw).replace(/[\s\-(). 　]/g, ""); }

  function regionName(iso, lang) {
    var l = lang === "en" ? "en" : "zh";
    if (NAMES[l][iso]) return NAMES[l][iso];
    try { return new Intl.DisplayNames([l === "en" ? "en" : "zh-CN"], { type: "region" }).of(iso) || iso; } catch (e) { return iso; }
  }

  /** The dropdown's two groups for a language: [{iso, label}] common first, then the rest A-Z in that language. */
  function options(lang) {
    var label = function (iso) { return regionName(iso, lang) + " +" + byIso[iso]; };
    var seen = {}, rest = [];
    COMMON.forEach(function (iso) { seen[iso] = 1; });
    DIAL.forEach(function (e) { if (!seen[e.iso]) { seen[e.iso] = 1; rest.push(e.iso); } });
    var collator;
    try { collator = new Intl.Collator(lang === "en" ? "en" : "zh-CN"); } catch (e) { collator = null; }
    var names = {};
    rest.forEach(function (iso) { names[iso] = regionName(iso, lang); });
    rest.sort(function (a, b) { return collator ? collator.compare(names[a], names[b]) : (names[a] < names[b] ? -1 : names[a] > names[b] ? 1 : 0); });
    return {
      common: COMMON.map(function (iso) { return { iso: iso, label: label(iso) }; }),
      rest: rest.map(function (iso) { return { iso: iso, label: label(iso) }; })
    };
  }

  function defaultFor(lang) { return lang === "en" ? "US" : "CN"; }
  function dialOf(iso) { return byIso[iso] || null; }
  function example(iso) { return EXAMPLES[iso] || null; }

  /**
   * The region a full international number belongs to: the longest calling code that starts it.
   * `prefer` keeps the current choice when it shares that code (Canada, Kazakhstan, Jersey...).
   * Returns {iso, national} or null.
   */
  function split(full, prefer) {
    var s = compact(full);
    if (/^00[1-9]/.test(s)) s = "+" + s.slice(2);
    if (!/^\+[1-9]\d*$/.test(s)) return null;
    var digits = s.slice(1);
    for (var len = 4; len >= 1; len--) {
      var code = digits.slice(0, len), hits = DIAL.filter(function (e) { return e.dial === code; });
      if (!hits.length) continue;
      var pick = prefer && hits.some(function (e) { return e.iso === prefer; }) ? prefer : PRIMARY[code] || hits[0].iso;
      return { iso: pick, national: digits.slice(len) };
    }
    return null;
  }

  /**
   * The number to send: a typed "+..." or "00..." number as typed (the dropdown is only a
   * convenience then); otherwise "+<code>" and the national digits, without a trunk 0
   * (or the leading 1 Americans often type). Empty input stays empty.
   */
  function combine(iso, raw) {
    var s = compact(raw);
    if (!s) return "";
    if (s.charAt(0) === "+" || /^00[1-9]/.test(s)) return ascii(String(raw).trim());
    var dial = byIso[iso];
    if (!dial) return ascii(String(raw).trim());
    if (dial === "1" && /^1\d{10}$/.test(s)) s = s.slice(1);
    else if (!KEEP_ZERO[iso] && /^0[1-9]/.test(s)) s = s.slice(1);
    return "+" + dial + s;
  }

  window.ritualPhoneCountry = { options: options, defaultFor: defaultFor, dialOf: dialOf, example: example, split: split, combine: combine, regionName: regionName };
})();
