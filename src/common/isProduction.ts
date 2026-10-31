import { isProductionMode } from './runtimeEnv';

export default function isProduction(): boolean {
	return isProductionMode();
	// return true; // for animations and other things debugging as in production mode
	// return false;
}
