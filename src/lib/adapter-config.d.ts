// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			/** ZENTRA Cloud API key (stored encrypted) */
			apiKey: string;
			/** Polling interval in minutes */
			pollInterval: number;
			/** Unit system requested from the API */
			units: 'metric' | 'imperial';
			/** Selected device serial numbers */
			devices: string[];
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
