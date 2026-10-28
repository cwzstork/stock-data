/**
 * 宏觀事件預覽的規則：新聞來源、主題關鍵字、受影響個股、方向與週期。
 *
 * 這裡不是 AI 判讀，是「關鍵字 → 主題 → 個股」的固定對照表。
 * 個股與方向是依產業常見的傳導關係預先寫好的（例如油價上漲 → 航空燃油成本上升），
 * 所以它回答的是「這類新聞通常會牽動誰」，不是「這則新聞會讓誰漲多少」。
 *
 * 規則的三個已知限制，畫面上也有寫：
 *   1. 只看標題。標題沒提到的內文細節判斷不到。
 *   2. 否定句只處理了常見寫法（「不降息」「暫停升息」），其他說法可能被誤判。
 *   3. 方向是「一般情況」。同一家公司可能同時受多個主題影響、方向相反，要合起來看。
 *
 * 個股清單寫的是股號＋股名。產生報告時會拿 stock 主檔逐一核對，
 * 股號不存在或股名對不上的直接丟掉並在報告裡列出——寫錯一個代號，
 * 寧可少一檔，也不要把利多掛到另一家公司頭上。
 */

export const CATEGORIES = {
  us: '美國政策',
  tw: '台灣政策',
  industry: '產業動態',
  flow: '國際資金',
  war: '戰爭與地緣',
  energy: '能源',
} as const;

export type Category = keyof typeof CATEGORIES;

/** 影響週期。是「這類消息通常反映在股價上的時間」，不是預測 */
export const HORIZONS = {
  short: { label: '短期', range: '數日～2 週' },
  mid: { label: '中期', range: '1～3 個月' },
  long: { label: '長期', range: '3 個月以上' },
} as const;

export type Horizon = keyof typeof HORIZONS;

// ── 新聞來源 ─────────────────────────────────────────────────────────

export interface FeedSource {
  id: string;
  label: string;
  url: string;
  /** 沒有對到任何主題的新聞歸到這一類的「其他新聞」；null 表示綜合來源，不歸類 */
  category: Category | null;
}

/**
 * Google 新聞搜尋 RSS。when:1d 限定最近一天，每個查詢最多回 100 則。
 * 實測 2026-10-28：中文查詢約 1 秒、英文約 0.3 秒，不需要金鑰。
 */
function gnews(q: string, lang: 'zh' | 'en' = 'zh'): string {
  const query = encodeURIComponent(`${q} when:1d`);
  return lang === 'zh'
    ? `https://news.google.com/rss/search?q=${query}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`
    : `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
}

export const FEEDS: FeedSource[] = [
  { id: 'g-fed', label: 'Google 新聞：聯準會利率', url: gnews('聯準會 降息 OR 升息 OR 利率'), category: 'us' },
  { id: 'g-us-tariff', label: 'Google 新聞：美國關稅', url: gnews('美國 關稅'), category: 'us' },
  { id: 'g-us-chip', label: 'Google 新聞：晶片出口管制', url: gnews('出口管制 晶片'), category: 'us' },
  { id: 'g-fed-en', label: 'Google News: Federal Reserve', url: gnews('Federal Reserve rates', 'en'), category: 'us' },
  { id: 'fed', label: 'Federal Reserve 貨幣政策新聞稿', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', category: 'us' },

  { id: 'g-cbc', label: 'Google 新聞：央行', url: gnews('央行 利率 OR 理監事會 OR 信用管制'), category: 'tw' },
  { id: 'g-tw-power', label: 'Google 新聞：電價與電力', url: gnews('電價 OR 限電 OR 電網 OR 綠電'), category: 'tw' },
  { id: 'g-tw-policy', label: 'Google 新聞：產業政策', url: gnews('行政院 OR 經濟部 OR 金管會 產業 政策'), category: 'tw' },
  { id: 'g-tw-defense', label: 'Google 新聞：國防', url: gnews('國防預算 OR 國防自主 OR 軍購'), category: 'tw' },

  { id: 'g-ai', label: 'Google 新聞：AI 伺服器', url: gnews('AI 伺服器 OR 輝達 OR CoWoS'), category: 'industry' },
  { id: 'g-memory', label: 'Google 新聞：記憶體', url: gnews('記憶體 報價 OR DRAM OR NAND'), category: 'industry' },
  { id: 'g-apple', label: 'Google 新聞：蘋果供應鏈', url: gnews('iPhone 拉貨 OR 蘋果 供應鏈'), category: 'industry' },
  { id: 'g-shipping', label: 'Google 新聞：航運', url: gnews('貨櫃 運價 OR 航運'), category: 'industry' },
  { id: 'g-china', label: 'Google 新聞：中國經濟', url: gnews('中國 刺激 OR 降準 OR 內需'), category: 'industry' },

  { id: 'g-foreign', label: 'Google 新聞：外資動向', url: gnews('外資 買超 OR 賣超 台股'), category: 'flow' },
  { id: 'g-twd', label: 'Google 新聞：新台幣匯率', url: gnews('新台幣 升值 OR 貶值'), category: 'flow' },
  { id: 'g-yield', label: 'Google 新聞：美債殖利率', url: gnews('美債殖利率'), category: 'flow' },

  { id: 'g-strait', label: 'Google 新聞：台海', url: gnews('台海 OR 共軍 OR 軍演'), category: 'war' },
  { id: 'g-mideast', label: 'Google 新聞：中東', url: gnews('中東 OR 以色列 OR 伊朗 OR 紅海'), category: 'war' },
  { id: 'g-ru-ua', label: 'Google 新聞：俄烏', url: gnews('俄烏 OR 烏克蘭 OR 俄羅斯'), category: 'war' },

  { id: 'g-oil', label: 'Google 新聞：油價', url: gnews('油價 OR 原油 OR OPEC'), category: 'energy' },
  { id: 'g-gas', label: 'Google 新聞：天然氣', url: gnews('天然氣 價格 OR LNG'), category: 'energy' },
  { id: 'eia', label: 'EIA Today in Energy', url: 'https://www.eia.gov/rss/todayinenergy.xml', category: 'energy' },

  { id: 'yahoo-tw', label: 'Yahoo 股市：台股', url: 'https://tw.stock.yahoo.com/rss?category=tw-market', category: null },
  { id: 'yahoo-intl', label: 'Yahoo 股市：國際', url: 'https://tw.stock.yahoo.com/rss?category=intl-markets', category: null },
];

// ── 主題 ─────────────────────────────────────────────────────────────

export interface Impact {
  stockId: string;
  /** 寫規則時以為的股名。產生報告時拿主檔核對，對不上就丟掉 */
  name: string;
  /** 主題「往正向發展」時對這檔的影響。tone 類主題的正向是「漲／強」 */
  effect: 1 | -1;
  horizon: Horizon;
  why: string;
}

export interface Theme {
  id: string;
  label: string;
  category: Category;
  /** 標題符合就算命中 */
  match: RegExp;
  /** 同時符合就不算，用來擋否定句（「不降息」不是降息） */
  exclude?: RegExp;
  /**
   * fixed：主題本身就帶方向（「降息」「關稅」），命中即正向；符合 reverse 時算反向（停火、和談）
   * tone ：方向看標題裡的漲跌字眼（「油價大漲」與「油價重挫」同一個主題、方向相反）
   */
  mode: 'fixed' | 'tone';
  reverse?: RegExp;
  /** 同時符合就不反轉：「鬆綁先別想」「尚不宜放寬」講的是管制繼續，不是鬆綁 */
  reverseExcept?: RegExp;
  /** tone 類的漲跌字眼。不給就用 UP_WORDS / DOWN_WORDS */
  up?: RegExp;
  down?: RegExp;
  summary: string;
  impacts: Impact[];
}

/** 一般性的漲跌字眼。只用多字詞——單字「高」「升」會撞到高雄、升息這種不相干的詞 */
export const UP_WORDS =
  /上漲|大漲|走高|攀升|飆|創新高|新高|上揚|勁揚|調漲|漲價|上修|優於預期|強勁|暢旺|熱賣|熱銷|大增|成長|回溫|擴產|追單|追加訂單|急單|缺貨|供不應求|surge|soar|jump|rall(?:y|ies)|\brise|rising|higher/gi;
export const DOWN_WORDS =
  /下跌|大跌|走低|重挫|回落|崩跌|下滑|跌破|調降|降價|下修|不如預期|疲弱|滯銷|衰退|減少|減產|砍單|放緩|萎縮|供過於求|庫存過高|plunge|slump|tumble|\bfall|falling|\bdrop|lower|decline/gi;

/** 衝突類主題的「降溫」字眼：命中時方向反轉 */
const DEESCALATE = /停火|和談|和平協議|休戰|撤軍|降溫|ceasefire|truce|peace (?:talks?|deal)/i;

/**
 * 台灣央行的利率主題要擋掉別國央行與「央行估聯準會…」這種主詞是別人的標題。
 * 實測 2026-10-28 抓到「紐西蘭央行升息預期」「央行估聯準會年底再升息」都被算成台灣央行升息。
 * 問句（「升息降息？」）是會前預測，不是決議，也擋掉。
 */
const NOT_TW_CB =
  /聯準會|Fed|美國|歐洲|歐銀|日本|日銀|英國|中國|人行|韓國|澳洲|澳幣|紐西蘭|紐幣|加拿大|瑞士|印度|印尼|土耳其|巴西|[?？]/i;

/**
 * 外資主題要的是「大盤資金流向」。每天的個股買賣超排行（「《外資》買超股：力積電、中鋼」）
 * 一天幾十則，講的是個股不是大盤，全擋掉；大盤方向另有 FinMind 的外資買賣超指標。
 * 「外資調節新興亞股，買超泰、印度、賣超台股」講的是別的市場，也擋。
 */
const FOREIGN_NOISE = /買超股|賣超股|[買賣]超前|[買賣]超\d|《外資|《\d+\/\d+日法人|新興亞股|泰股|印度|韓股|TOP|最夯股|^\d{4,6}\s/i;
/**
 * 而且標題要有大盤層級的字眼。實測「外資砸數十億買超南亞科」「中鋼盤後解析：外資主力同步買超」
 * 都是個股新聞，擋名單擋不完；反過來要求出現台股、大盤、億元、匯出這類字眼比較穩。
 * 寫成開頭的 lookahead，字眼在「外資」前後都可以。
 */
const FOREIGN_MARKET = '^(?=.*(?:台股|大盤|集中市場|上市櫃|現貨|億元|兆|匯出|匯入|提款))';

/**
 * 戰爭類要「地名 ＋ 衝突字眼」同時出現。實測光有地名會抓到「以色列大選出口民調」
 * 「國籍航空飛越俄羅斯領空」，前者跟戰事無關，後者其實是航線恢復（對航空是好事）。
 * 停火、和談也算衝突字眼——它們會命中、再由 reverse 把方向反過來。
 */
function conflict(places: string): RegExp {
  return new RegExp(
    `^(?=.*(?:${places}))(?=.*(?:衝突|戰|攻擊|襲擊|飛彈|導彈|空襲|轟炸|封鎖|制裁|報復|增兵|停火|和談|休戰|attack|strike|missile|war\\b|conflict|sanction|ceasefire|truce|peace))`,
    'i',
  );
}

export const THEMES: Theme[] = [
  // ── 美國政策 ──
  {
    id: 'us-rate-cut',
    label: '美國降息',
    category: 'us',
    // 要帶美國的主詞：光寫「降息」會把歐洲央行、人行降息都算進來
    match: /(?:聯準會|Fed|FOMC|美國).{0,15}(?:降息|減息)|(?:降息|減息).{0,15}(?:聯準會|Fed|FOMC|美國)|rate cuts?|cuts? (?:interest )?rates/i,
    exclude: /不降息|暫停降息|降息無望|延後降息|排除降息|降息預期降溫|降息機率下降/,
    mode: 'fixed',
    summary: '美國降息壓低美元利率、帶動資金回流風險資產；壽險的債券部位評價回升，銀行的外幣利差則會收窄。',
    impacts: [
      { stockId: '2882', name: '國泰金', effect: 1, horizon: 'mid', why: '債券部位評價回升、避險成本下降' },
      { stockId: '2881', name: '富邦金', effect: 1, horizon: 'mid', why: '債券部位評價回升、避險成本下降' },
      { stockId: '2330', name: '台積電', effect: 1, horizon: 'short', why: '資金回流成長股，外資買盤通常先進權值股' },
      { stockId: '2454', name: '聯發科', effect: 1, horizon: 'short', why: '高本益比成長股對利率最敏感' },
      { stockId: '2542', name: '興富發', effect: 1, horizon: 'mid', why: '營建業負債比高，資金成本下降' },
      { stockId: '2886', name: '兆豐金', effect: -1, horizon: 'mid', why: '外幣放款比重高，美元利率下降壓縮利差' },
    ],
  },
  {
    id: 'us-rate-hike',
    label: '美國升息／利率偏鷹',
    category: 'us',
    match: /(?:聯準會|Fed|FOMC|美國).{0,15}(?:升息|加息|鷹派)|(?:升息|加息).{0,15}(?:聯準會|Fed|FOMC|美國)|rate hikes?|raises? (?:interest )?rates|hawkish/i,
    exclude: /不升息|暫停升息|停止升息|升息循環結束|排除升息/,
    mode: 'fixed',
    summary: '美國升息或釋出鷹派訊號，資金成本上升、成長股評價承壓；壽險債券評價下跌，銀行外幣利差擴大。',
    impacts: [
      { stockId: '2882', name: '國泰金', effect: -1, horizon: 'mid', why: '債券部位評價下跌' },
      { stockId: '2881', name: '富邦金', effect: -1, horizon: 'mid', why: '債券部位評價下跌' },
      { stockId: '2330', name: '台積電', effect: -1, horizon: 'short', why: '資金撤出成長股，外資賣壓先落在權值股' },
      { stockId: '2454', name: '聯發科', effect: -1, horizon: 'short', why: '高本益比成長股對利率最敏感' },
      { stockId: '2542', name: '興富發', effect: -1, horizon: 'mid', why: '營建業負債比高，資金成本上升' },
      { stockId: '2886', name: '兆豐金', effect: 1, horizon: 'mid', why: '外幣放款比重高，美元利率上升擴大利差' },
    ],
  },
  {
    id: 'us-tariff',
    label: '美國關稅',
    category: 'us',
    // 要帶美國的主詞，否則歐盟、中國的關稅新聞也會算進來
    match: /(?:美國|美方|白宮|川普|Trump).{0,15}關稅|關稅.{0,15}(?:美國|美方|白宮)|對等關稅|232 ?條款|tariffs?/i,
    mode: 'fixed',
    // 實測「擬放寬鋼鐵、汽車關稅」「擬降鋼鐵車輛關稅」「關稅協議即將達成」都是降溫，原本的寫法漏掉
    reverse:
      /(?:豁免|調降|降低|下調|取消|暫緩|放寬|減免|擬降)[^，,。！]{0,8}關稅|關稅.{0,6}(?:豁免|調降|降低|下調|取消|暫緩|放寬|減免|協議|降溫)|tariff (?:exemption|cut|pause|relief|deal)/i,
    summary: '美國提高關稅會墊高輸美產品成本，毛利低、輸美比重高的組裝與成衣製鞋最先受影響；廠商要靠移轉產地因應，影響會拖上一段時間。',
    impacts: [
      { stockId: '2317', name: '鴻海', effect: -1, horizon: 'mid', why: '輸美組裝比重高，關稅牽動產線移轉成本' },
      { stockId: '4938', name: '和碩', effect: -1, horizon: 'mid', why: '輸美組裝比重高，毛利薄' },
      { stockId: '9910', name: '豐泰', effect: -1, horizon: 'mid', why: '運動鞋輸美比重高' },
      { stockId: '1477', name: '聚陽', effect: -1, horizon: 'mid', why: '成衣輸美比重高' },
      { stockId: '2330', name: '台積電', effect: -1, horizon: 'short', why: '半導體是否被納入關稅範圍' },
    ],
  },
  {
    id: 'us-export-control',
    label: '美國晶片出口管制',
    category: 'us',
    match: /出口管制|實體清單|晶片禁令|禁售|export controls?|entity list/i,
    mode: 'fixed',
    reverse: /放寬|鬆綁|解禁|lift(?:s|ed)? (?:the )?ban|eas(?:e|es|ed) (?:export )?controls?/i,
    summary: '美國擴大對中國的晶片出口管制，有中國客戶的設計與製造業者短期營收受壓。',
    impacts: [
      { stockId: '2454', name: '聯發科', effect: -1, horizon: 'short', why: '中國手機客戶比重高' },
      { stockId: '3443', name: '創意', effect: -1, horizon: 'short', why: '部分 ASIC 客戶在中國' },
      { stockId: '2330', name: '台積電', effect: -1, horizon: 'short', why: '對中國的先進製程出貨受管制範圍影響' },
      { stockId: '3711', name: '日月光投控', effect: -1, horizon: 'short', why: '中國客戶的封測訂單受管制範圍影響' },
    ],
  },
  {
    id: 'us-chips-subsidy',
    label: '美國晶片補助',
    category: 'us',
    match: /晶片法案|CHIPS Act|半導體補貼|半導體補助/i,
    mode: 'fixed',
    summary: '美國的半導體補助降低海外擴產成本，影響的是設廠時程與長期毛利。',
    impacts: [
      { stockId: '2330', name: '台積電', effect: 1, horizon: 'long', why: '美國廠建置有補助，海外擴產成本降低' },
    ],
  },

  // ── 台灣政策 ──
  {
    id: 'tw-rate-hike',
    label: '台灣央行升息',
    category: 'tw',
    match: /(?:央行|理監事會).{0,12}(?:升息|調升利率|升半碼|升一碼)/,
    exclude: new RegExp(`不升息|利率不變|維持利率|${NOT_TW_CB.source}`, 'i'),
    mode: 'fixed',
    summary: '央行升息擴大銀行存放款利差，但加重房貸負擔、壓抑房市。',
    impacts: [
      { stockId: '2884', name: '玉山金', effect: 1, horizon: 'mid', why: '存放款利差擴大' },
      { stockId: '2891', name: '中信金', effect: 1, horizon: 'mid', why: '存放款利差擴大' },
      { stockId: '2542', name: '興富發', effect: -1, horizon: 'mid', why: '房貸負擔加重，推案去化放慢' },
      { stockId: '2548', name: '華固', effect: -1, horizon: 'mid', why: '房貸負擔加重，推案去化放慢' },
    ],
  },
  {
    id: 'tw-rate-cut',
    label: '台灣央行降息',
    category: 'tw',
    match: /(?:央行|理監事會).{0,12}(?:降息|調降利率|降半碼|降一碼)/,
    exclude: new RegExp(`不降息|利率不變|維持利率|${NOT_TW_CB.source}`, 'i'),
    mode: 'fixed',
    summary: '央行降息壓縮銀行利差，但減輕房貸負擔、有利房市。',
    impacts: [
      { stockId: '2884', name: '玉山金', effect: -1, horizon: 'mid', why: '存放款利差收窄' },
      { stockId: '2891', name: '中信金', effect: -1, horizon: 'mid', why: '存放款利差收窄' },
      { stockId: '2542', name: '興富發', effect: 1, horizon: 'mid', why: '房貸負擔減輕' },
      { stockId: '2548', name: '華固', effect: 1, horizon: 'mid', why: '房貸負擔減輕' },
    ],
  },
  {
    id: 'tw-credit-control',
    label: '房市信用管制',
    category: 'tw',
    match: /信用管制|打房|限貸|房貸成數|房貸管制|囤房稅/,
    mode: 'fixed',
    // 實測「打房不再硬碰硬？央行漸進式鬆綁」的鬆綁離「管制」很遠，要整句看；
    // 但「房市鬆綁先別想」「尚不宜大放寬」講的是管制繼續，不能反轉
    reverse: /鬆綁|放寬|解除|不再硬碰硬/,
    reverseExcept: /先別想|不宜|尚不|暫不|不會/,
    summary: '央行收緊房貸、政府打房，建商推案去化放慢，影響通常延續一季以上。',
    impacts: [
      { stockId: '2542', name: '興富發', effect: -1, horizon: 'mid', why: '房貸鬆緊直接影響推案去化' },
      { stockId: '2548', name: '華固', effect: -1, horizon: 'mid', why: '房貸鬆緊直接影響推案去化' },
      { stockId: '5522', name: '遠雄', effect: -1, horizon: 'mid', why: '房貸鬆緊直接影響推案去化' },
      { stockId: '2501', name: '國建', effect: -1, horizon: 'mid', why: '房貸鬆緊直接影響推案去化' },
    ],
  },
  {
    id: 'tw-power-price',
    label: '電價調漲',
    category: 'tw',
    match: /電價.{0,8}(?:調漲|上漲|漲價|漲幅)/,
    exclude: /凍漲|不漲|維持不變|不調整/,
    mode: 'fixed',
    summary: '電價調漲直接墊高用電大戶的成本，鋼鐵、水泥、石化最明顯。',
    impacts: [
      { stockId: '2002', name: '中鋼', effect: -1, horizon: 'mid', why: '用電大戶，電費占成本比重高' },
      { stockId: '1101', name: '台泥', effect: -1, horizon: 'mid', why: '用電大戶，電費占成本比重高' },
      { stockId: '1326', name: '台化', effect: -1, horizon: 'mid', why: '石化製程耗電，成本上升' },
      { stockId: '2330', name: '台積電', effect: -1, horizon: 'mid', why: '用電量全台最大，但電費占營收比重不高，影響有限' },
    ],
  },
  {
    id: 'tw-grid',
    label: '電網與綠能建設',
    category: 'tw',
    // 要帶台灣的主詞。實測光寫「電網」會抓到 Hubbell、50Hertz、美國能源部這些國外新聞
    match:
      /強韌電網|台電.{0,10}(?:電網|標案|採購|擴建|饋線)|(?:台灣|我國|國內|經濟部).{0,10}(?:電網|綠電|太陽光電|儲能|離岸風電|缺電|限電|核電)|核三|限電|缺電/,
    mode: 'fixed',
    summary: '電網韌性、綠能與供電議題都會推動台電的強化電網與再生能源採購，重電設備商受惠時間長。',
    impacts: [
      { stockId: '1513', name: '中興電', effect: 1, horizon: 'long', why: '台電電網標案主要供應商' },
      { stockId: '1519', name: '華城', effect: 1, horizon: 'long', why: '變壓器需求增加' },
      { stockId: '1503', name: '士電', effect: 1, horizon: 'long', why: '重電設備需求增加' },
      { stockId: '9958', name: '世紀鋼', effect: 1, horizon: 'long', why: '離岸風電水下基礎' },
    ],
  },
  {
    id: 'tw-defense',
    label: '國防預算與國防自主',
    category: 'tw',
    // 「無人機」要帶台灣的脈絡。實測會抓到「俄羅斯煉油廠…無人機攻擊停歇」
    match:
      /國防預算|國防自主|軍購|國艦國造|國防產業|(?:國防|國軍|台灣|國產|軍用).{0,8}無人機|無人機.{0,8}(?:國家隊|採購|國防|軍購)/,
    mode: 'fixed',
    summary: '國防預算增加與國防自主政策，帶動軍機、無人機與造艦的國內訂單。',
    impacts: [
      { stockId: '2634', name: '漢翔', effect: 1, horizon: 'mid', why: '軍機與航太零組件訂單' },
      { stockId: '8033', name: '雷虎', effect: 1, horizon: 'mid', why: '無人機題材' },
      { stockId: '2208', name: '台船', effect: 1, horizon: 'mid', why: '國艦國造' },
    ],
  },

  // ── 產業動態 ──
  {
    id: 'ai-server',
    label: 'AI 伺服器需求',
    category: 'industry',
    match: /AI ?伺服器|AI 需求|輝達|NVIDIA|Nvidia|CoWoS|資料中心|data cent(?:er|re)|GB[23]00/i,
    mode: 'tone',
    summary: 'AI 資本支出的強弱直接反映在伺服器組裝、先進製程、散熱與電源供應鏈的出貨上。',
    impacts: [
      { stockId: '2382', name: '廣達', effect: 1, horizon: 'mid', why: 'AI 伺服器組裝' },
      { stockId: '3231', name: '緯創', effect: 1, horizon: 'mid', why: 'AI 伺服器組裝' },
      { stockId: '6669', name: '緯穎', effect: 1, horizon: 'mid', why: '雲端資料中心伺服器' },
      { stockId: '2330', name: '台積電', effect: 1, horizon: 'mid', why: '先進製程與 CoWoS 封裝產能' },
      { stockId: '3017', name: '奇鋐', effect: 1, horizon: 'mid', why: '伺服器散熱' },
      { stockId: '2308', name: '台達電', effect: 1, horizon: 'mid', why: '資料中心電源' },
    ],
  },
  {
    id: 'memory',
    label: '記憶體報價',
    category: 'industry',
    match: /DRAM|NAND|記憶體|HBM/i,
    mode: 'tone',
    // 記憶體「減產」是供給減少、報價上漲的訊號，跟一般「減產＝衰退」相反
    up: /上漲|大漲|漲價|調漲|走高|攀升|飆|上揚|缺貨|供不應求|減產|回溫|強勁/g,
    down: /下跌|大跌|跌價|降價|調降|走低|重挫|供過於求|庫存過高|疲弱|下滑/g,
    summary: '記憶體報價直接反映在記憶體廠的毛利上，漲跌通常延續一到兩季。',
    impacts: [
      { stockId: '2408', name: '南亞科', effect: 1, horizon: 'mid', why: 'DRAM 報價直接反映在獲利' },
      { stockId: '2344', name: '華邦電', effect: 1, horizon: 'mid', why: '利基型記憶體報價' },
      { stockId: '8299', name: '群聯', effect: 1, horizon: 'short', why: 'NAND 模組庫存評價跟著報價走' },
    ],
  },
  {
    id: 'apple',
    label: '蘋果供應鏈',
    category: 'industry',
    // 光寫「蘋果」會抓到「市值超越輝達與蘋果總和」這種跟供應鏈無關的標題
    match: /iPhone|蘋果.{0,6}(?:供應鏈|拉貨|訂單|銷售|出貨|新機|備貨|砍單|追單)|Apple.{0,12}(?:iPhone|sales|orders|shipments)/i,
    mode: 'tone',
    summary: 'iPhone 的拉貨與銷售強弱，影響組裝、鏡頭與機殼供應鏈的出貨。',
    impacts: [
      { stockId: '2317', name: '鴻海', effect: 1, horizon: 'short', why: 'iPhone 組裝' },
      { stockId: '3008', name: '大立光', effect: 1, horizon: 'short', why: '手機鏡頭' },
      { stockId: '4938', name: '和碩', effect: 1, horizon: 'short', why: 'iPhone 組裝' },
      { stockId: '2474', name: '可成', effect: 1, horizon: 'short', why: '機殼' },
    ],
  },
  {
    id: 'shipping',
    label: '貨櫃運價',
    category: 'industry',
    match: /運價|貨櫃|SCFI|航運/,
    mode: 'tone',
    summary: '貨櫃運價漲跌幾乎一對一反映在貨櫃三雄的獲利，股價反應快。',
    impacts: [
      { stockId: '2603', name: '長榮', effect: 1, horizon: 'short', why: '運價直接反映在獲利' },
      { stockId: '2609', name: '陽明', effect: 1, horizon: 'short', why: '運價直接反映在獲利' },
      { stockId: '2615', name: '萬海', effect: 1, horizon: 'short', why: '運價直接反映在獲利' },
    ],
  },
  {
    id: 'china-stimulus',
    label: '中國刺激經濟',
    category: 'industry',
    match: /(?:中國|大陸|陸方|人行|國務院).{0,10}(?:刺激|降準|降息|救市|擴大內需|紓困)/,
    mode: 'fixed',
    summary: '中國刺激內需會帶動塑化、鋼鐵、水泥等原物料需求，通常是短線行情。',
    impacts: [
      { stockId: '1301', name: '台塑', effect: 1, horizon: 'short', why: '塑化需求回溫' },
      { stockId: '1303', name: '南亞', effect: 1, horizon: 'short', why: '塑化需求回溫' },
      { stockId: '2002', name: '中鋼', effect: 1, horizon: 'short', why: '亞洲鋼價跟著中國需求走' },
      { stockId: '1101', name: '台泥', effect: 1, horizon: 'short', why: '中國水泥事業' },
    ],
  },

  // ── 國際資金 ──
  {
    id: 'foreign-buy',
    label: '外資買超',
    category: 'flow',
    match: new RegExp(`${FOREIGN_MARKET}.*外資.{0,6}(?:買超|回補|匯入|加碼|大買)`),
    exclude: FOREIGN_NOISE,
    mode: 'fixed',
    summary: '外資買盤集中在權值股，連續買超通常伴隨新台幣升值。',
    impacts: [
      { stockId: '2330', name: '台積電', effect: 1, horizon: 'short', why: '外資持股比重最高的權值股' },
      { stockId: '2317', name: '鴻海', effect: 1, horizon: 'short', why: '外資主要進出的權值股' },
      { stockId: '2454', name: '聯發科', effect: 1, horizon: 'short', why: '外資主要進出的權值股' },
    ],
  },
  {
    id: 'foreign-sell',
    label: '外資賣超',
    category: 'flow',
    match: new RegExp(`${FOREIGN_MARKET}.*外資.{0,6}(?:賣超|提款|匯出|減碼|調節|大賣)`),
    exclude: FOREIGN_NOISE,
    mode: 'fixed',
    summary: '外資賣壓集中在權值股，連續賣超通常伴隨新台幣貶值。',
    impacts: [
      { stockId: '2330', name: '台積電', effect: -1, horizon: 'short', why: '外資持股比重最高的權值股' },
      { stockId: '2317', name: '鴻海', effect: -1, horizon: 'short', why: '外資主要進出的權值股' },
      { stockId: '2454', name: '聯發科', effect: -1, horizon: 'short', why: '外資主要進出的權值股' },
    ],
  },
  {
    id: 'twd-up',
    label: '新台幣升值',
    category: 'flow',
    match: /(?:新台幣|台幣).{0,6}(?:升值|走升|強升|升破)/,
    mode: 'fixed',
    summary: '新台幣升值讓以美元計價的營收換回台幣變少（匯損），以美元計價成本的航空業則受惠。',
    impacts: [
      { stockId: '2330', name: '台積電', effect: -1, horizon: 'short', why: '美元營收換算成台幣變少' },
      { stockId: '2317', name: '鴻海', effect: -1, horizon: 'short', why: '美元營收換算成台幣變少' },
      { stockId: '2882', name: '國泰金', effect: -1, horizon: 'short', why: '海外資產匯損、避險成本上升' },
      { stockId: '2610', name: '華航', effect: 1, horizon: 'short', why: '燃油與飛機租金以美元計價' },
      { stockId: '2618', name: '長榮航', effect: 1, horizon: 'short', why: '燃油與飛機租金以美元計價' },
    ],
  },
  {
    id: 'twd-down',
    label: '新台幣貶值',
    category: 'flow',
    match: /(?:新台幣|台幣).{0,6}(?:貶值|走貶|重貶|貶破)/,
    mode: 'fixed',
    summary: '新台幣貶值讓出口商的美元營收換回台幣變多（匯兌收益），以美元計價成本的航空業則受壓。',
    impacts: [
      { stockId: '2330', name: '台積電', effect: 1, horizon: 'short', why: '美元營收換算成台幣變多' },
      { stockId: '2317', name: '鴻海', effect: 1, horizon: 'short', why: '美元營收換算成台幣變多' },
      { stockId: '2882', name: '國泰金', effect: 1, horizon: 'short', why: '海外資產匯兌收益' },
      { stockId: '2610', name: '華航', effect: -1, horizon: 'short', why: '燃油與飛機租金以美元計價' },
      { stockId: '2618', name: '長榮航', effect: -1, horizon: 'short', why: '燃油與飛機租金以美元計價' },
    ],
  },
  {
    id: 'us-yield',
    label: '美債殖利率',
    category: 'flow',
    match: /美債殖利率|公債殖利率|Treasury yields?/i,
    mode: 'tone',
    summary: '美債殖利率上升代表無風險利率走高，成長股評價承壓、壽險債券評價下跌；下降則相反。',
    impacts: [
      { stockId: '2882', name: '國泰金', effect: -1, horizon: 'mid', why: '債券部位評價與殖利率反向' },
      { stockId: '2881', name: '富邦金', effect: -1, horizon: 'mid', why: '債券部位評價與殖利率反向' },
      { stockId: '2330', name: '台積電', effect: -1, horizon: 'short', why: '無風險利率高低牽動成長股評價' },
      { stockId: '2454', name: '聯發科', effect: -1, horizon: 'short', why: '無風險利率高低牽動成長股評價' },
    ],
  },

  // ── 戰爭與地緣 ──
  {
    id: 'taiwan-strait',
    label: '台海情勢',
    category: 'war',
    // 「軍演」要是對台的。實測光寫軍演會抓到「美日利劍軍演」
    match: /台海|共軍|共機|解放軍|東部戰區|圍台|海峽情勢|(?:對台|中共).{0,6}(?:軍演|演習)/,
    mode: 'fixed',
    reverse: DEESCALATE,
    summary: '台海緊張時外資先賣權值股避險、國防股有題材；過去經驗是幾天到兩週內消化。',
    impacts: [
      { stockId: '2330', name: '台積電', effect: -1, horizon: 'short', why: '情勢緊張時外資先賣權值股避險' },
      { stockId: '2634', name: '漢翔', effect: 1, horizon: 'short', why: '國防題材' },
      { stockId: '8033', name: '雷虎', effect: 1, horizon: 'short', why: '無人機題材' },
      { stockId: '2208', name: '台船', effect: 1, horizon: 'short', why: '國艦國造題材' },
    ],
  },
  {
    id: 'middle-east',
    label: '中東情勢',
    category: 'war',
    match: conflict('中東|以色列|伊朗|胡塞|紅海|荷莫茲|Hormuz|Israel|Iran|Houthi'),
    mode: 'fixed',
    reverse: DEESCALATE,
    summary: '中東衝突推升油價、船隻繞道好望角推升運價；航空業燃油成本上升。',
    impacts: [
      { stockId: '2603', name: '長榮', effect: 1, horizon: 'short', why: '紅海航線受阻與否牽動運價' },
      { stockId: '2609', name: '陽明', effect: 1, horizon: 'short', why: '紅海航線受阻與否牽動運價' },
      { stockId: '6505', name: '台塑化', effect: 1, horizon: 'short', why: '存貨評價跟著油價走' },
      { stockId: '2610', name: '華航', effect: -1, horizon: 'short', why: '燃油成本跟著油價走' },
      { stockId: '2618', name: '長榮航', effect: -1, horizon: 'short', why: '燃油成本跟著油價走' },
    ],
  },
  {
    id: 'russia-ukraine',
    label: '俄烏戰爭',
    category: 'war',
    match: conflict('俄烏|烏克蘭|俄羅斯|Ukraine|Russia|Kremlin'),
    mode: 'fixed',
    reverse: DEESCALATE,
    summary: '俄烏戰事升溫主要透過能源價格傳導：油價上漲有利煉油、不利航空；和談消息則相反。',
    impacts: [
      { stockId: '6505', name: '台塑化', effect: 1, horizon: 'short', why: '存貨評價跟著油價走' },
      { stockId: '2634', name: '漢翔', effect: 1, horizon: 'short', why: '國防需求題材' },
      { stockId: '2610', name: '華航', effect: -1, horizon: 'short', why: '燃油成本跟著油價走' },
      { stockId: '2618', name: '長榮航', effect: -1, horizon: 'short', why: '燃油成本跟著油價走' },
    ],
  },

  // ── 能源 ──
  {
    id: 'oil',
    label: '國際油價',
    category: 'energy',
    match: /油價|原油|布蘭特|WTI|OPEC|crude|oil prices?/i,
    mode: 'tone',
    // OPEC「減產」是油價上漲的訊號，「增產」才是下跌
    up: /上漲|大漲|漲[近逾了]|收漲|走高|攀升|飆|創新高|上揚|勁揚|反彈|重返|減產|限產|供應中斷|surge|soar|jump|\brise|rising|higher/gi,
    down: /下跌|大跌|跌[近逾了]|收跌|下挫|走低|重挫|回落|回檔|崩跌|下滑|跌破|增產|供過於求|供應壓力緩和|plunge|slump|tumble|\bfall|falling|\bdrop|lower/gi,
    summary: '油價漲跌影響煉油業的存貨評價與產品報價，以及航空業約三成的燃油成本。',
    impacts: [
      { stockId: '6505', name: '台塑化', effect: 1, horizon: 'short', why: '存貨評價與產品報價跟著油價走' },
      { stockId: '2610', name: '華航', effect: -1, horizon: 'short', why: '燃油約占營業成本三成' },
      { stockId: '2618', name: '長榮航', effect: -1, horizon: 'short', why: '燃油約占營業成本三成' },
    ],
  },
  {
    id: 'natgas',
    label: '天然氣價格',
    category: 'energy',
    match: /天然氣|LNG|natural gas/i,
    mode: 'tone',
    // 氣價新聞常寫「維持高位」「削減供應」，一般字眼抓不到方向
    up: /上漲|大漲|走高|攀升|飆|高位|削減|減供|短缺|供應中斷|surge|soar|jump|higher/gi,
    down: /下跌|大跌|走低|回落|重挫|供過於求|過剩|plunge|slump|\bfall|lower/gi,
    summary: '台灣發電近半靠天然氣，氣價上漲墊高台電成本、增加電價調漲壓力，傳導到用電大戶要比較久。',
    impacts: [
      { stockId: '2002', name: '中鋼', effect: -1, horizon: 'long', why: '氣價牽動發電成本與電價調整壓力' },
      { stockId: '1101', name: '台泥', effect: -1, horizon: 'long', why: '氣價牽動發電成本與電價調整壓力' },
    ],
  },
];

export const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));

// ── 量化指標的觸發門檻 ────────────────────────────────────────────────
//
// 指標是「有沒有大到值得一提」，門檻取的是一般認為的明顯波動，不是統計推導。

export const INDICATOR_RULES = {
  /** 外資（含外資自營）近 5 個交易日累計買賣超，單位：億元 */
  foreignNet5d: { buy: 300, sell: -300 },
  /** 美元兌新台幣近 5 筆變動 %。負的是新台幣升值 */
  usdTwd5d: { pct: 1 },
  /** WTI 近 5 筆變動 % */
  wti5d: { pct: 5 },
  /** 美債 10 年期近 5 筆變動，單位：百分點 */
  us10y5d: { pts: 0.15 },
  /** 資料日期離今天超過這麼多天就不拿來觸發主題（原油常落後一週以上） */
  staleDays: 7,
} as const;
