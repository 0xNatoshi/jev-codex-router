"""Preserve Grok's measured tier across LiteLLM's non-streaming Chat bridge."""
from litellm.integrations.custom_logger import CustomLogger


class GrokServiceTierCallback(CustomLogger):
    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        if data.get("model") != "grok-oauth-grok-4-6":
            return response
        # The OpenAI adapter retains actual upstream headers in hidden_params;
        # its Responses conversion copies those, but drops Chat service_tier.
        # Never consult request service_tier, credentials, or response text.
        hidden = getattr(response, "_hidden_params", None)
        headers = hidden.get("headers") if isinstance(hidden, dict) else None
        tier = headers.get("x-codex-router-grok-service-tier") if isinstance(headers, dict) else None
        if tier not in ("default", "priority", "unknown"):
            return response
        fields = getattr(response, "provider_specific_fields", None)
        fields = dict(fields) if isinstance(fields, dict) else {}
        fields["grok_service_tier"] = tier
        response.provider_specific_fields = fields
        if tier != "unknown":
            response.service_tier = tier
        return response


grok_service_tier_callback = GrokServiceTierCallback()
