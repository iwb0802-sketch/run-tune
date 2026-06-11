import type { Plugin } from "vite";

export default function runableAnalyticsPlugin(): Plugin {
	return {
		name: "runable-analytics-plugin",
		enforce: "pre",
		transformIndexHtml(html) {
			const applicationId = process.env.APPLICATION_ID ?? "";
			const hostname = applicationId
				? `${applicationId}-website`
				: "localhost";

			const debugAttr = hostname === "localhost" ? `data-debug="${hostname}"` : "";

			const scriptTag = `<script defer src="/runable.js" data-hostname="${hostname}" data-url="https://r.lilstts.com/events" ${debugAttr}></script>`;

			return html.replace("</head>", `${scriptTag}\n</head>`);
		},
	};
}
