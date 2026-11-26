/// Whether `lower` contains `llama` not immediately preceded by `o`,
/// mirroring rikkahub's `(?<!o)llama` lookbehind so `ollama` itself does not
/// count as a Llama/meta match.
fn has_standalone_llama(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    bytes
        .windows(5)
        .enumerate()
        .any(|(i, w)| w == b"llama" && (i == 0 || bytes[i - 1] != b'o'))
}

fn has_meta_word(lower: &str) -> bool {
    lower.match_indices("meta").any(|(index, _)| {
        let end = index + 4;
        let starts_at_word_boundary = index == 0
            || !lower.as_bytes()[index - 1].is_ascii_alphanumeric()
                && lower.as_bytes()[index - 1] != b'_';
        let ends_at_word_boundary = match lower.as_bytes().get(end) {
            None => true,
            Some(byte) => !byte.is_ascii_alphanumeric() && *byte != b'_',
        };
        starts_at_word_boundary && ends_at_word_boundary
    })
}

/// Map a model name to a fixed local icon filename served under `/icons`.
///
/// Matching follows rikkahub's `computeAIIconByName` ordered precedence:
/// the first keyword family that matches wins, so overlapping names such as
/// `openai/o3` (OpenAI before later suffixes), `gemini/google` (Gemini
/// before Google), and `ollama/llama` (the standalone `llama` meta match
/// before the Ollama rule) resolve predictably. Matching is
/// case-insensitive; the model name is never concatenated into a filesystem
/// path — the returned value is always one of the fixed filenames below,
/// falling back to `rikkahub.svg` for unknown models.
pub fn icon_for(model: &str) -> &'static str {
    let lower = model.to_ascii_lowercase();
    // Order is significant: keep the same precedence as rikkahub so
    // overlapping keywords resolve deterministically (first match wins).
    if lower.contains("gpt")
        || lower.contains("openai")
        || lower
            .as_bytes()
            .windows(2)
            .any(|w| w[0] == b'o' && w[1].is_ascii_digit())
    {
        // OpenAI: gpt/openai/o\d (e.g. openai/o3, o3-mini).
        "openai.svg"
    } else if lower.contains("gemini") || lower.contains("nano-banana") {
        "gemini-color.svg"
    } else if lower.contains("google") {
        "google-color.svg"
    } else if lower.contains("claude") {
        "claude-color.svg"
    } else if lower.contains("anthropic") {
        "anthropic.svg"
    } else if lower.contains("deepseek") {
        "deepseek-color.svg"
    } else if lower.contains("grok") {
        "grok.svg"
    } else if lower.contains("qwen") || lower.contains("qwq") || lower.contains("qvq") {
        "qwen-color.svg"
    } else if lower.contains("doubao") {
        "doubao-color.svg"
    } else if lower.contains("openrouter") {
        "openrouter.svg"
    } else if lower.contains("zhipu") || lower.contains("glm") {
        "zhipu-color.svg"
    } else if lower.contains("mistral") {
        "mistral-color.svg"
    } else if has_meta_word(&lower) || has_standalone_llama(&lower) {
        "meta-color.svg"
    } else if lower.contains("hunyuan") || lower.contains("tencent") {
        "hunyuan-color.svg"
    } else if lower.contains("gemma") {
        "gemma-color.svg"
    } else if lower.contains("perplexity") {
        "perplexity-color.svg"
    } else if lower.contains("aliyun")
        || lower.contains("alibaba")
        || lower.contains("阿里云")
        || lower.contains("百炼")
    {
        "alibabacloud-color.svg"
    } else if lower.contains("bytedance") || lower.contains("volcengine") || lower.contains("火山")
    {
        "bytedance-color.svg"
    } else if lower.contains("silicon") {
        "siliconflow.svg"
    } else if lower.contains("aihubmix") {
        "aihubmix-color.svg"
    } else if lower.contains("ollama") {
        "ollama.svg"
    } else if lower.contains("github") {
        "github.svg"
    } else if lower.contains("cloudflare") {
        "cloudflare-color.svg"
    } else if lower.contains("minimax") {
        "minimax-color.svg"
    } else if lower.contains("xai") {
        "xai.svg"
    } else if lower.contains("juhenext") {
        "juhenext.png"
    } else if lower.contains("kimi") {
        "kimi-color.svg"
    } else if lower.contains("moonshot") {
        "moonshot.svg"
    } else if lower.contains("302") {
        "302ai.svg"
    } else if lower.contains("step") || lower.contains("阶跃") {
        "stepfun-color.svg"
    } else if lower.contains("intern") || lower.contains("书生") {
        "internlm-color.svg"
    } else if lower.contains("cohere") || lower.contains("command-") {
        "cohere-color.svg"
    } else if lower.contains("tavern") {
        "tavern.png"
    } else if lower.contains("cerebras") {
        "cerebras-color.svg"
    } else if lower.contains("nvidia") {
        "nvidia-color.svg"
    } else if lower.contains("ppio") {
        "ppio-color.svg"
    } else if lower.contains("vercel") {
        "vercel.svg"
    } else if lower.contains("groq") {
        "groq.svg"
    } else if lower.contains("tokenpony") {
        "tokenpony.svg"
    } else if lower.contains("ling") || lower.contains("ring") {
        "ling.png"
    } else if lower.contains("mimo") || lower.contains("xiaomi") {
        "xiaomimimo.svg"
    } else if lower.contains("longcat") {
        "longcat-color.svg"
    } else if lower.contains("elevenlabs") {
        "elevenlabs.svg"
    } else if lower.contains("fish-audio") || lower.contains("fishaudio") {
        "fish-audio.svg"
    } else if lower.contains("rikka") || lower.contains("auto") {
        "rikkahub.svg"
    } else if lower.contains("linkup") {
        "linkup.png"
    } else if lower.contains("bing") {
        "bing.png"
    } else if lower.contains("tavily") {
        "tavily.png"
    } else if lower.contains("exa") {
        "exa.png"
    } else if lower.contains("brave") {
        "brave.svg"
    } else if lower.contains("metaso") || lower.contains("秘塔") {
        "metaso.svg"
    } else if lower.contains("firecrawl") {
        "firecrawl.svg"
    } else if lower.contains("jina") {
        "jina.svg"
    } else if lower.contains("searxng") {
        "searxng.svg"
    } else if lower.contains("xiaoke") {
        "xiaoke.svg"
    } else {
        // Deterministic local fallback for unknown names.
        "rikkahub.svg"
    }
}

#[cfg(test)]
mod tests {
    use super::icon_for;

    #[test]
    fn icon_for_maps_distinct_providers() {
        // Given representative provider model names spanning each family,
        // When resolved,
        // Then each maps to its expected local icon filename.
        assert_eq!(icon_for("gpt-4o"), "openai.svg");
        assert_eq!(icon_for("gemini-2.5-pro"), "gemini-color.svg");
        assert_eq!(icon_for("google/gemma-3"), "google-color.svg");
        assert_eq!(icon_for("claude-haiku"), "claude-color.svg");
        assert_eq!(icon_for("anthropic-v1"), "anthropic.svg");
        assert_eq!(icon_for("deepseek-v4"), "deepseek-color.svg");
        assert_eq!(icon_for("grok-4"), "grok.svg");
        assert_eq!(icon_for("qwq-32b"), "qwen-color.svg");
        assert_eq!(icon_for("doubao-1.5"), "doubao-color.svg");
        assert_eq!(icon_for("openrouter-chat"), "openrouter.svg");
        assert_eq!(icon_for("glm-4.6"), "zhipu-color.svg");
        assert_eq!(icon_for("mistral-7b"), "mistral-color.svg");
        assert_eq!(icon_for("llama-3.3"), "meta-color.svg");
        assert_eq!(icon_for("hunyuan-t1"), "hunyuan-color.svg");
        assert_eq!(icon_for("gemma-3-27b"), "gemma-color.svg");
        assert_eq!(icon_for("perplexity/sonar"), "perplexity-color.svg");
        assert_eq!(icon_for("aliyun-chat"), "alibabacloud-color.svg");
        assert_eq!(icon_for("bytedance-chat"), "bytedance-color.svg");
        assert_eq!(icon_for("silicon-chat"), "siliconflow.svg");
        assert_eq!(icon_for("aihubmix-chat"), "aihubmix-color.svg");
        assert_eq!(icon_for("ollama-v2"), "ollama.svg");
        assert_eq!(icon_for("github-copilot"), "github.svg");
        assert_eq!(icon_for("cloudflare-v1"), "cloudflare-color.svg");
        assert_eq!(icon_for("minimax-m2"), "minimax-color.svg");
        assert_eq!(icon_for("xai/grok"), "grok.svg");
        assert_eq!(icon_for("juhenext-1"), "juhenext.png");
        assert_eq!(icon_for("moonshot-v1"), "moonshot.svg");
        assert_eq!(icon_for("302ai-chat"), "302ai.svg");
        assert_eq!(icon_for("step-2"), "stepfun-color.svg");
        assert_eq!(icon_for("internlm3"), "internlm-color.svg");
        assert_eq!(icon_for("command-r"), "cohere-color.svg");
        assert_eq!(icon_for("tavern-v1"), "tavern.png");
        assert_eq!(icon_for("cerebras-lite"), "cerebras-color.svg");
        assert_eq!(icon_for("nvidia-nim"), "nvidia-color.svg");
        assert_eq!(icon_for("ppio-1"), "ppio-color.svg");
        assert_eq!(icon_for("vercel-llm"), "vercel.svg");
        assert_eq!(icon_for("groq-v1"), "groq.svg");
        assert_eq!(icon_for("tokenpony-1"), "tokenpony.svg");
        assert_eq!(icon_for("ring-2503"), "ling.png");
        assert_eq!(icon_for("mimo-mini"), "xiaomimimo.svg");
        assert_eq!(icon_for("longcat-v1"), "longcat-color.svg");
        assert_eq!(icon_for("elevenlabs-turbo"), "elevenlabs.svg");
        assert_eq!(icon_for("fishaudio-lv"), "fish-audio.svg");
    }

    #[test]
    fn icon_for_resolves_overlapping_names_in_order() {
        // Given names whose substrings match more than one family,
        // When resolved against the ordered precedence,
        // Then the first matching family (rikkahub order) wins.
        assert_eq!(icon_for("openai/o3-mini"), "openai.svg");
        assert_eq!(icon_for("gemini-google"), "gemini-color.svg");
        assert_eq!(icon_for("google-gemini"), "gemini-color.svg");
        assert_eq!(icon_for("ollama/llama3"), "meta-color.svg");
        assert_eq!(icon_for("deepseek-meta-llama"), "deepseek-color.svg");
        assert_eq!(icon_for("gpt-4o-mini"), "openai.svg");
        // "ollama" itself must not be taken as the `(?<!o)llama` meta match,
        // so it falls through to the Ollama rule.
        assert_eq!(icon_for("ollama-v2"), "ollama.svg");
        assert_eq!(icon_for("openrouter/auto"), "openrouter.svg");
        assert_eq!(icon_for("auto"), "rikkahub.svg");
    }

    #[test]
    fn icon_for_is_case_insensitive() {
        // Given the same model name in different casings,
        // When resolved,
        // Then the icon is identical regardless of case.
        assert_eq!(icon_for("DEEPSEEK-V4"), "deepseek-color.svg");
        assert_eq!(icon_for("DeepSeek-V4"), "deepseek-color.svg");
        assert_eq!(icon_for("MINIMAX-M2"), "minimax-color.svg");
        assert_eq!(icon_for("OpenAI/o3"), "openai.svg");
    }

    #[test]
    fn icon_for_uses_xiaoke_for_unmatched_xiaoke_names() {
        assert_eq!(icon_for("xiaoke-5"), "xiaoke.svg");
        assert_eq!(icon_for("xiaoke-5-Ascend"), "xiaoke.svg");
        assert_eq!(icon_for("openai/xiaoke-gpt"), "openai.svg");
    }

    #[test]
    fn icon_for_falls_back_to_rikkahub_for_unknown_models() {
        // Given an unrecognized or empty model name,
        // When resolved,
        // Then the deterministic local fallback is returned.
        assert_eq!(icon_for("unknown-vendor-model"), "rikkahub.svg");
        assert_eq!(icon_for(""), "rikkahub.svg");
        assert_eq!(icon_for("somemetadata-model"), "rikkahub.svg");
    }
}
