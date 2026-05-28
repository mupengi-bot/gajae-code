export const MODEL_ONBOARDING_API_PROVIDER_COMMAND =
	"/provider add --compat <openai|anthropic> --provider <id> --base-url <url> --api-key-env <ENV> --model <model>";

export const MODEL_ONBOARDING_SETUP_COMMAND = "gjc setup provider";
export const MODEL_ONBOARDING_OAUTH_COMMAND = "/provider login [provider-id] or /login [provider-id]";

export function formatModelOnboardingGuidance(): string {
	return [
		"Model selection only shows configured providers.",
		"Assignment targets are DEFAULT plus the GJC role agents: EXECUTOR, ARCHITECT, PLANNER, and CRITIC.",
		"Legacy model-role aliases are compatibility-only and are not shown as assignment targets.",
		`API-compatible providers: ${MODEL_ONBOARDING_API_PROVIDER_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND}).`,
		`OAuth/subscription providers: ${MODEL_ONBOARDING_OAUTH_COMMAND}.`,
		"Then run /model to select a configured model or assign it to a target.",
	].join("\n");
}

export function formatModelOnboardingInlineHint(): string {
	return `Add API-compatible providers with ${MODEL_ONBOARDING_API_PROVIDER_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND}); OAuth/subscription with ${MODEL_ONBOARDING_OAUTH_COMMAND}; then run /model for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, and CRITIC.`;
}

export function formatNoModelOnboardingError(): string {
	return `No model selected.\n\n${formatModelOnboardingGuidance()}`;
}

export function formatNoCredentialOnboardingError(providerId: string): string {
	return [
		`No credentials found for ${providerId}.`,
		"",
		`For API-compatible providers, configure credentials with ${MODEL_ONBOARDING_API_PROVIDER_COMMAND} (or ${MODEL_ONBOARDING_SETUP_COMMAND}).`,
		`For OAuth/subscription providers, use ${MODEL_ONBOARDING_OAUTH_COMMAND}.`,
		"Then run /model to select a configured model or assign it to DEFAULT, EXECUTOR, ARCHITECT, PLANNER, or CRITIC.",
	].join("\n");
}

export function formatNoModelsAvailableFallback(): string {
	return `No models available. ${formatModelOnboardingGuidance()}`;
}
