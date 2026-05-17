// Fetch edge location from Cloudflare's cdn-cgi/trace endpoint (same domain, always available)
export interface EdgeLocation {
	colo: string;   // IATA airport code, e.g. "SJC"
	city: string;   // Human-readable city name
	country: string; // ISO 3166-1 alpha-2, e.g. "US"
}

// Curated map of Cloudflare data center IATA codes → city names
// Source: https://www.cloudflare.com/network/
const IATA_TO_CITY: Record<string, string> = {
	AMS: "阿姆斯特丹", ARN: "斯德哥尔摩", ATH: "雅典", ATL: "亚特兰大",
	AUH: "阿布扎比", BKK: "曼谷", BLR: "班加罗尔", BOM: "孟买",
	BOS: "波士顿", BRU: "布鲁塞尔", BUD: "布达佩斯", CAI: "开罗",
	CAN: "广州", CDG: "巴黎", CGK: "雅加达", CMH: "哥伦布",
	CPH: "哥本哈根", CPT: "开普敦", DAL: "达拉斯", DEL: "新德里",
	DEN: "丹佛", DFW: "达拉斯", DOH: "多哈", DUB: "都柏林",
	DUS: "杜塞尔多夫", EWR: "纽约", EZE: "布宜诺斯艾利斯",
	FCO: "罗马", FRA: "法兰克福", GIG: "里约热内卢", GRU: "圣保罗",
	HAN: "河内", HAM: "汉堡", HEL: "赫尔辛基", HKG: "香港",
	HND: "东京", IAD: "华盛顿", IAH: "休斯顿", ICN: "首尔",
	JFK: "纽约", JNB: "约翰内斯堡", KHI: "卡拉奇", KIX: "大阪",
	KUL: "吉隆坡", LAX: "洛杉矶", LHR: "伦敦", LIM: "利马",
	LIS: "里斯本", MAA: "金奈", MAD: "马德里", MAN: "曼彻斯特",
	MCI: "堪萨斯城", MCO: "奥兰多", MEL: "墨尔本", MEX: "墨西哥城",
	MIA: "迈阿密", MNL: "马尼拉", MRS: "马赛", MSP: "明尼阿波利斯",
	MUC: "慕尼黑", MXP: "米兰", NBO: "内罗毕", NRT: "东京",
	NYC: "纽约", OPO: "波尔图", ORD: "芝加哥", OSL: "奥斯陆",
	OTP: "布加勒斯特", PDX: "波特兰", PEK: "北京", PHX: "凤凰城",
	PIT: "匹兹堡", PRG: "布拉格", PVG: "上海", RIC: "里士满",
	RIX: "里加", SCL: "圣地亚哥", SEA: "西雅图", SFO: "旧金山",
	SGN: "胡志明市", SIN: "新加坡", SJC: "圣何塞", SLC: "盐湖城",
	SOF: "索非亚", STL: "圣路易斯", STO: "斯德哥尔摩", SYD: "悉尼",
	TLV: "特拉维夫", TPE: "台北", TXL: "柏林", VIE: "维也纳",
	VNO: "维尔纽斯", WAW: "华沙", YUL: "蒙特利尔", YVR: "温哥华",
	YYZ: "多伦多", ZAG: "萨格勒布", ZRH: "苏黎世",
};

const COUNTRY_TO_NAME: Record<string, string> = {
	US: "美国", CN: "中国", HK: "中国香港", TW: "中国台湾",
	SG: "新加坡", JP: "日本", KR: "韩国", GB: "英国",
	DE: "德国", FR: "法国", NL: "荷兰", AU: "澳大利亚",
	CA: "加拿大", IN: "印度", BR: "巴西", RU: "俄罗斯",
};

let cached: EdgeLocation | null = null;

export async function fetchEdgeLocation(): Promise<EdgeLocation | null> {
	if (cached) return cached;
	try {
		const res = await fetch("/cdn-cgi/trace", { cache: "no-store" });
		if (!res.ok) return null;
		const text = await res.text();
		const get = (key: string) => {
			const m = text.match(new RegExp(`^${key}=(.+)$`, "m"));
			return m ? m[1].trim() : "";
		};
		const colo = get("colo");
		const loc = get("loc");
		const city = IATA_TO_CITY[colo] ?? colo;
		const country = COUNTRY_TO_NAME[loc] ?? loc;
		cached = { colo, city, country };
		return cached;
	} catch {
		return null;
	}
}
