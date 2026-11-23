"""Build Pheme's global searchable public company directory (assets/companies.json).

Combines:
1. Official SEC EDGAR US exchange-listed companies (NYSE, NASDAQ, CBOE, major OTC)
2. Curated major global listings: UK FTSE 100 / LSE, Europe (Euronext, XETRA, SIX,
   BME, Milan, Nordic), India (NSE / NIFTY 50), Japan (TSE), Hong Kong (HKEX),
   Korea (KRX), Australia (ASX), Canada (TSX), major global ETFs and crypto.
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'companies.json'

SEC_URL = 'https://www.sec.gov/files/company_tickers_exchange.json'

# [ticker, name, exchange, sector, tv_symbol]
GLOBAL_COMPANIES = [
    # UK (LSE / FTSE 100 & major UK)
    ['SHEL', 'Shell', 'LSE', 'Energy', 'LSE:SHEL'],
    ['AZN', 'AstraZeneca', 'LSE', 'Pharmaceuticals', 'LSE:AZN'],
    ['HSBA', 'HSBC Holdings', 'LSE', 'Banking', 'LSE:HSBA'],
    ['ULVR', 'Unilever', 'LSE', 'Consumer goods', 'LSE:ULVR'],
    ['BP.', 'BP', 'LSE', 'Energy', 'LSE:BP.'],
    ['GSK', 'GSK', 'LSE', 'Pharmaceuticals', 'LSE:GSK'],
    ['RIO', 'Rio Tinto', 'LSE', 'Mining', 'LSE:RIO'],
    ['DGE', 'Diageo', 'LSE', 'Beverages', 'LSE:DGE'],
    ['REL', 'RELX', 'LSE', 'Information services', 'LSE:REL'],
    ['LSEG', 'London Stock Exchange Group', 'LSE', 'Financial markets', 'LSE:LSEG'],
    ['BARC', 'Barclays', 'LSE', 'Banking', 'LSE:BARC'],
    ['LLOY', 'Lloyds Banking Group', 'LSE', 'Banking', 'LSE:LLOY'],
    ['NWG', 'NatWest Group', 'LSE', 'Banking', 'LSE:NWG'],
    ['RR.', 'Rolls-Royce Holdings', 'LSE', 'Aerospace & defence', 'LSE:RR.'],
    ['BA.', 'BAE Systems', 'LSE', 'Aerospace & defence', 'LSE:BA.'],
    ['TSCO', 'Tesco', 'LSE', 'Retail', 'LSE:TSCO'],
    ['SBRY', 'Sainsbury’s', 'LSE', 'Retail', 'LSE:SBRY'],
    ['MKS', 'Marks & Spencer', 'LSE', 'Retail', 'LSE:MKS'],
    ['NXT', 'Next', 'LSE', 'Retail', 'LSE:NXT'],
    ['VOD', 'Vodafone Group', 'LSE', 'Telecoms', 'LSE:VOD'],
    ['BT.A', 'BT Group', 'LSE', 'Telecoms', 'LSE:BT.A'],
    ['GLEN', 'Glencore', 'LSE', 'Mining & commodities', 'LSE:GLEN'],
    ['AAL', 'Anglo American', 'LSE', 'Mining', 'LSE:AAL'],
    ['EXPN', 'Experian', 'LSE', 'Data & credit', 'LSE:EXPN'],
    ['CPG', 'Compass Group', 'LSE', 'Services', 'LSE:CPG'],
    ['NG.', 'National Grid', 'LSE', 'Utilities', 'LSE:NG.'],
    ['SSE', 'SSE', 'LSE', 'Utilities', 'LSE:SSE'],
    ['PRU', 'Prudential', 'LSE', 'Insurance', 'LSE:PRU'],
    ['LGEN', 'Legal & General', 'LSE', 'Financial services', 'LSE:LGEN'],
    ['AV.', 'Aviva', 'LSE', 'Insurance', 'LSE:AV.'],
    ['STAN', 'Standard Chartered', 'LSE', 'Banking', 'LSE:STAN'],
    ['EZJ', 'easyJet', 'LSE', 'Airlines', 'LSE:EZJ'],
    ['IAG', 'International Airlines Group (British Airways)', 'LSE', 'Airlines', 'LSE:IAG'],
    ['WPP', 'WPP', 'LSE', 'Advertising', 'LSE:WPP'],
    ['OCDO', 'Ocado Group', 'LSE', 'Retail tech', 'LSE:OCDO'],
    ['HLN', 'Haleon', 'LSE', 'Consumer health', 'LSE:HLN'],
    ['BATS', 'British American Tobacco', 'LSE', 'Consumer goods', 'LSE:BATS'],
    ['IMB', 'Imperial Brands', 'LSE', 'Consumer goods', 'LSE:IMB'],
    ['RKT', 'Reckitt Benckiser', 'LSE', 'Consumer goods', 'LSE:RKT'],
    ['ABF', 'Associated British Foods (Primark)', 'LSE', 'Retail & food', 'LSE:ABF'],
    ['BRBY', 'Burberry Group', 'LSE', 'Luxury', 'LSE:BRBY'],
    ['AUTO', 'Auto Trader Group', 'LSE', 'Digital marketplace', 'LSE:AUTO'],
    ['RMV', 'Rightmove', 'LSE', 'Property portal', 'LSE:RMV'],
    ['SGE', 'Sage Group', 'LSE', 'Software', 'LSE:SGE'],
    ['IHG', 'InterContinental Hotels Group', 'LSE', 'Hospitality', 'LSE:IHG'],
    ['JD.', 'JD Sports Fashion', 'LSE', 'Retail', 'LSE:JD.'],
    ['FLTR', 'Flutter Entertainment', 'LSE', 'Gaming', 'LSE:FLTR'],
    ['SMT', 'Scottish Mortgage Investment Trust', 'LSE', 'Investment trust', 'LSE:SMT'],
    ['WISE', 'Wise', 'LSE', 'Fintech', 'LSE:WISE'],
    ['GRG', 'Greggs', 'LSE', 'Food retail', 'LSE:GRG'],
    ['JET2', 'Jet2', 'LSE', 'Travel & airlines', 'LSE:JET2'],
    ['MONY', 'Mony Group (MoneySuperMarket)', 'LSE', 'Digital services', 'LSE:MONY'],

    # Europe (Euronext, XETRA, SIX, Milan, Madrid, Nordic)
    ['MC', 'LVMH Moët Hennessy Louis Vuitton', 'EURONEXT', 'Luxury', 'EURONEXT:MC'],
    ['RMS', 'Hermès International', 'EURONEXT', 'Luxury', 'EURONEXT:RMS'],
    ['OR', 'L’Oréal', 'EURONEXT', 'Consumer goods', 'EURONEXT:OR'],
    ['TTE', 'TotalEnergies', 'EURONEXT', 'Energy', 'EURONEXT:TTE'],
    ['AIR', 'Airbus', 'EURONEXT', 'Aerospace', 'EURONEXT:AIR'],
    ['SAN', 'Sanofi', 'EURONEXT', 'Pharmaceuticals', 'EURONEXT:SAN'],
    ['BNP', 'BNP Paribas', 'EURONEXT', 'Banking', 'EURONEXT:BNP'],
    ['CS', 'AXA', 'EURONEXT', 'Insurance', 'EURONEXT:CS'],
    ['KER', 'Kering', 'EURONEXT', 'Luxury', 'EURONEXT:KER'],
    ['SAF', 'Safran', 'EURONEXT', 'Aerospace & defence', 'EURONEXT:SAF'],
    ['SU', 'Schneider Electric', 'EURONEXT', 'Industrials', 'EURONEXT:SU'],
    ['ADYEN', 'Adyen', 'EURONEXT', 'Payments', 'EURONEXT:ADYEN'],
    ['ASML', 'ASML Holding (Amsterdam)', 'EURONEXT', 'Semiconductors', 'EURONEXT:ASML'],
    ['SAP', 'SAP (Frankfurt)', 'XETR', 'Enterprise software', 'XETR:SAP'],
    ['SIE', 'Siemens', 'XETR', 'Industrials', 'XETR:SIE'],
    ['ALV', 'Allianz', 'XETR', 'Insurance', 'XETR:ALV'],
    ['DTE', 'Deutsche Telekom', 'XETR', 'Telecoms', 'XETR:DTE'],
    ['MBG', 'Mercedes-Benz Group', 'XETR', 'Automotive', 'XETR:MBG'],
    ['BMW', 'BMW', 'XETR', 'Automotive', 'XETR:BMW'],
    ['VOW3', 'Volkswagen', 'XETR', 'Automotive', 'XETR:VOW3'],
    ['ADS', 'Adidas', 'XETR', 'Apparel', 'XETR:ADS'],
    ['LHA', 'Lufthansa', 'XETR', 'Airlines', 'XETR:LHA'],
    ['RHM', 'Rheinmetall', 'XETR', 'Defence', 'XETR:RHM'],
    ['BAYN', 'Bayer', 'XETR', 'Healthcare & agriculture', 'XETR:BAYN'],
    ['IFX', 'Infineon Technologies', 'XETR', 'Semiconductors', 'XETR:IFX'],
    ['DHL', 'DHL Group', 'XETR', 'Logistics', 'XETR:DHL'],
    ['DBK', 'Deutsche Bank', 'XETR', 'Banking', 'XETR:DBK'],
    ['NESN', 'Nestlé', 'SIX', 'Consumer goods', 'SIX:NESN'],
    ['ROG', 'Roche Holding', 'SIX', 'Pharmaceuticals', 'SIX:ROG'],
    ['NOVN', 'Novartis', 'SIX', 'Pharmaceuticals', 'SIX:NOVN'],
    ['UBSG', 'UBS Group', 'SIX', 'Banking', 'SIX:UBSG'],
    ['ABB', 'ABB', 'SIX', 'Industrials', 'SIX:ABBN'],
    ['NOVO_B', 'Novo Nordisk (Copenhagen)', 'OMXCOP', 'Pharmaceuticals', 'OMXCOP:NOVO_B'],
    ['RACE', 'Ferrari', 'NYSE', 'Automotive', 'NYSE:RACE'],
    ['UCG', 'UniCredit', 'MIL', 'Banking', 'MIL:UCG'],
    ['ISP', 'Intesa Sanpaolo', 'MIL', 'Banking', 'MIL:ISP'],
    ['ENEL', 'Enel', 'MIL', 'Utilities', 'MIL:ENEL'],
    ['ITX', 'Inditex (Zara)', 'BME', 'Retail', 'BME:ITX'],
    ['SAN.MC', 'Banco Santander', 'BME', 'Banking', 'BME:SAN'],
    ['BBVA', 'BBVA', 'BME', 'Banking', 'BME:BBVA'],
    ['IBE', 'Iberdrola', 'BME', 'Utilities', 'BME:IBE'],
    ['RYA', 'Ryanair Holdings', 'EURONEXT', 'Airlines', 'NASDAQ:RYAAY'],

    # India (NSE / NIFTY 50)
    ['RELIANCE', 'Reliance Industries', 'NSE', 'Conglomerate & energy', 'NSE:RELIANCE'],
    ['TCS', 'Tata Consultancy Services', 'NSE', 'IT services', 'NSE:TCS'],
    ['HDFCBANK', 'HDFC Bank', 'NSE', 'Banking', 'NSE:HDFCBANK'],
    ['ICICIBANK', 'ICICI Bank', 'NSE', 'Banking', 'NSE:ICICIBANK'],
    ['INFY', 'Infosys', 'NSE', 'IT services', 'NSE:INFY'],
    ['BHARTIARTL', 'Bharti Airtel', 'NSE', 'Telecoms', 'NSE:BHARTIARTL'],
    ['ITC', 'ITC', 'NSE', 'Consumer goods', 'NSE:ITC'],
    ['SBIN', 'State Bank of India', 'NSE', 'Banking', 'NSE:SBIN'],
    ['LT', 'Larsen & Toubro', 'NSE', 'Infrastructure', 'NSE:LT'],
    ['HINDUNILVR', 'Hindustan Unilever', 'NSE', 'Consumer goods', 'NSE:HINDUNILVR'],
    ['BAJFINANCE', 'Bajaj Finance', 'NSE', 'Financial services', 'NSE:BAJFINANCE'],
    ['KOTAKBANK', 'Kotak Mahindra Bank', 'NSE', 'Banking', 'NSE:KOTAKBANK'],
    ['AXISBANK', 'Axis Bank', 'NSE', 'Banking', 'NSE:AXISBANK'],
    ['MARUTI', 'Maruti Suzuki India', 'NSE', 'Automotive', 'NSE:MARUTI'],
    ['SUNPHARMA', 'Sun Pharmaceutical', 'NSE', 'Pharmaceuticals', 'NSE:SUNPHARMA'],
    ['TITAN', 'Titan Company', 'NSE', 'Consumer retail', 'NSE:TITAN'],
    ['TATAMOTORS', 'Tata Motors', 'NSE', 'Automotive', 'NSE:TATAMOTORS'],
    ['TATASTEEL', 'Tata Steel', 'NSE', 'Metals', 'NSE:TATASTEEL'],
    ['WIPRO', 'Wipro', 'NSE', 'IT services', 'NSE:WIPRO'],
    ['HCLTECH', 'HCL Technologies', 'NSE', 'IT services', 'NSE:HCLTECH'],
    ['M&M', 'Mahindra & Mahindra', 'NSE', 'Automotive', 'NSE:M_M'],
    ['NTPC', 'NTPC', 'NSE', 'Utilities', 'NSE:NTPC'],
    ['ONGC', 'Oil and Natural Gas Corporation', 'NSE', 'Energy', 'NSE:ONGC'],
    ['ADANIENT', 'Adani Enterprises', 'NSE', 'Conglomerate', 'NSE:ADANIENT'],
    ['ADANIPORTS', 'Adani Ports', 'NSE', 'Logistics', 'NSE:ADANIPORTS'],
    ['ASIANPAINT', 'Asian Paints', 'NSE', 'Materials', 'NSE:ASIANPAINT'],
    ['ULTRACEMCO', 'UltraTech Cement', 'NSE', 'Materials', 'NSE:ULTRACEMCO'],
    ['JSWSTEEL', 'JSW Steel', 'NSE', 'Metals', 'NSE:JSWSTEEL'],
    ['DMART', 'Avenue Supermarts (DMart)', 'NSE', 'Retail', 'NSE:DMART'],
    ['ETERNAL', 'Zomato / Eternal', 'NSE', 'Consumer tech', 'NSE:ETERNAL'],

    # Asia-Pacific & Canada
    ['7203', 'Toyota Motor', 'TSE', 'Automotive', 'TSE:7203'],
    ['6758', 'Sony Group', 'TSE', 'Electronics & media', 'TSE:6758'],
    ['7974', 'Nintendo', 'TSE', 'Gaming', 'TSE:7974'],
    ['9984', 'SoftBank Group', 'TSE', 'Technology & investing', 'TSE:9984'],
    ['6861', 'Keyence', 'TSE', 'Automation', 'TSE:6861'],
    ['8306', 'Mitsubishi UFJ Financial', 'TSE', 'Banking', 'TSE:8306'],
    ['9983', 'Fast Retailing (Uniqlo)', 'TSE', 'Retail', 'TSE:9983'],
    ['005930', 'Samsung Electronics', 'KRX', 'Semiconductors & electronics', 'KRX:005930'],
    ['000660', 'SK Hynix', 'KRX', 'Semiconductors', 'KRX:000660'],
    ['005380', 'Hyundai Motor', 'KRX', 'Automotive', 'KRX:005380'],
    ['0700', 'Tencent Holdings', 'HKEX', 'Technology', 'HKEX:700'],
    ['9988', 'Alibaba Group (Hong Kong)', 'HKEX', 'E-commerce & cloud', 'HKEX:9988'],
    ['3690', 'Meituan', 'HKEX', 'Consumer tech', 'HKEX:3690'],
    ['1211', 'BYD Company', 'HKEX', 'Electric vehicles', 'HKEX:1211'],
    ['1810', 'Xiaomi', 'HKEX', 'Consumer electronics', 'HKEX:1810'],
    ['2330', 'TSMC (Taiwan)', 'TWSE', 'Semiconductors', 'TWSE:2330'],
    ['BHP', 'BHP Group', 'ASX', 'Mining', 'ASX:BHP'],
    ['CBA', 'Commonwealth Bank of Australia', 'ASX', 'Banking', 'ASX:CBA'],
    ['CSL', 'CSL', 'ASX', 'Biotechnology', 'ASX:CSL'],
    ['RY', 'Royal Bank of Canada', 'TSX', 'Banking', 'NYSE:RY'],
    ['TD', 'Toronto-Dominion Bank', 'TSX', 'Banking', 'NYSE:TD'],

    # Popular ETFs, Indices & Crypto
    ['SPY', 'SPDR S&P 500 ETF Trust', 'AMEX', 'ETF · US Equities', 'AMEX:SPY'],
    ['VOO', 'Vanguard S&P 500 ETF', 'AMEX', 'ETF · US Equities', 'AMEX:VOO'],
    ['QQQ', 'Invesco QQQ Trust (Nasdaq 100)', 'NASDAQ', 'ETF · US Tech', 'NASDAQ:QQQ'],
    ['VTI', 'Vanguard Total Stock Market ETF', 'AMEX', 'ETF · US Equities', 'AMEX:VTI'],
    ['IWM', 'iShares Russell 2000 ETF', 'AMEX', 'ETF · US Small Cap', 'AMEX:IWM'],
    ['GLD', 'SPDR Gold Shares ETF', 'AMEX', 'ETF · Commodities', 'AMEX:GLD'],
    ['SLV', 'iShares Silver Trust ETF', 'AMEX', 'ETF · Commodities', 'AMEX:SLV'],
    ['TLT', 'iShares 20+ Year Treasury Bond ETF', 'NASDAQ', 'ETF · Bonds', 'NASDAQ:TLT'],
    ['VWRL', 'Vanguard FTSE All-World UCITS ETF', 'LSE', 'ETF · Global Equities', 'LSE:VWRL'],
    ['VUSA', 'Vanguard S&P 500 UCITS ETF', 'LSE', 'ETF · US Equities', 'LSE:VUSA'],
    ['ISF', 'iShares Core FTSE 100 UCITS ETF', 'LSE', 'ETF · UK Equities', 'LSE:ISF'],
    ['BTCUSD', 'Bitcoin / US Dollar', 'BITSTAMP', 'Cryptocurrency', 'BITSTAMP:BTCUSD'],
    ['ETHUSD', 'Ethereum / US Dollar', 'BITSTAMP', 'Cryptocurrency', 'BITSTAMP:ETHUSD'],
    ['GOLD', 'Gold Spot (XAU/USD)', 'TVC', 'Commodity', 'TVC:GOLD'],
    ['UKOIL', 'Brent Crude Oil', 'TVC', 'Commodity', 'TVC:UKOIL'],
]

EXCHANGE_MAP = {
    'Nasdaq': 'NASDAQ',
    'NYSE': 'NYSE',
    'CBOE': 'CBOE',
    'OTC': 'OTC',
}

UPPER_KEEP = {'IBM', 'AMD', 'TSMC', 'SAP', 'BP', 'GSK', 'HSBC', 'UBS', 'ABB', 'BMW', 'DHL', 'LVMH', 'AI', 'US', 'UK', 'EU', 'USA', 'ETF', 'PLC', 'NV', 'SA', 'AG', 'SE', 'LP', 'LLC', 'INC', 'CORP', 'CO', 'LTD', 'REIT', 'B2B', '3M'}


def clean_sec_name(raw):
    s = re.sub(r'\s+', ' ', str(raw or '').strip())
    if not s:
        return ''
    if s.isupper():
        words = []
        for w in s.split(' '):
            bare = re.sub(r'[^A-Za-z0-9]', '', w)
            if bare in UPPER_KEEP and len(bare) <= 4:
                words.append(w)
            elif '/' in w:
                words.append('/'.join(p.capitalize() for p in w.split('/')))
            else:
                words.append(w.capitalize())
        s = ' '.join(words)
    # Strip trailing corporate noise for clean search display while keeping full clarity
    s = re.sub(r'\s+/DE/?$', '', s, flags=re.I)
    s = re.sub(r'\s+/MD/?$', '', s, flags=re.I)
    s = re.sub(r'\s+/NV/?$', '', s, flags=re.I)
    return s.strip()


def fetch_sec_companies():
    req = urllib.request.Request(
        SEC_URL,
        headers={'User-Agent': 'PhemeNewsDirectory/1.0 (contact@pheme24.online)'},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    rows = []
    seen = set()
    for _cik, raw_name, ticker, raw_ex in data.get('data', []):
        ticker = str(ticker or '').strip().upper()
        ex = EXCHANGE_MAP.get(str(raw_ex or '').strip(), '')
        if not ticker or not ex or ex == 'OTC':
            continue
        # Skip warrant/unit suffix duplicates when very long, keep standard tickers & class shares
        if len(ticker) > 8 or not re.match(r'^[A-Z0-9.-]+$', ticker):
            continue
        key = (ex, ticker)
        if key in seen:
            continue
        seen.add(key)
        name = clean_sec_name(raw_name)
        if not name:
            continue
        tv_sym = ex + ':' + ticker.replace('-', '.')
        rows.append([ticker, name, ex, 'Listed equity', tv_sym])
    return rows


def main():
    sec_rows = fetch_sec_companies()
    merged = []
    seen_tv = set()
    # Curated global listings first so UK/Europe/India/Asia/ETFs rank cleanly.
    for row in GLOBAL_COMPANIES:
        tv = row[4]
        if tv not in seen_tv:
            seen_tv.add(tv)
            merged.append(row)
    for row in sec_rows:
        tv = row[4]
        if tv not in seen_tv:
            seen_tv.add(tv)
            merged.append(row)

    payload = {
        'version': 1,
        'count': len(merged),
        'companies': merged,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'Wrote {OUT.name}: {len(merged)} public companies ({OUT.stat().st_size / 1024:.1f} KB).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
