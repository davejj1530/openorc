# MiniLM tokenizer compatibility

OpenOrc uses **`@huggingface/tokenizers@0.2.0`**, a dependency-free Apache-2.0 JavaScript implementation, through a MiniLM-specific adapter in the [FastEmbed patch](../patches/fastembed@2.1.0.patch). It replaces the obsolete native `@anush008/tokenizers` dependency while preserving existing embeddings.

Both FastEmbed module formats use `lib/minilm-tokenizer.cjs`. The adapter accepts the reviewed `sentence-transformers/all-MiniLM-L6-v2` identity, WordPiece/Bert normalization and single-sequence template, validates the special-token map and padding ID, and rejects unsupported configurations. Sparse embeddings and other model identities are explicitly unsupported by this OpenOrc patch.

The workspace override removes the native dependency; a package extension and the patched runtime manifest supply Tokenizers.js. Keep these pieces and the lockfile together. The package's original Apache license is preserved under [licenses/vendor](../licenses/vendor/huggingface-tokenizers-Apache.txt); FastEmbed retains its MIT license.

## Compatibility seam

This is not an npm-alias replacement. FastEmbed's [published implementation](https://github.com/Anush008/fastembed-js/blob/15fa4a9805ddd8ab1fc347b8cc3032484f29bac2/src/fastembed.ts) uses `Tokenizer.fromFile`, mutating padding/truncation methods, and encoding getters. Tokenizers.js instead accepts parsed `tokenizer.json` and `tokenizer_config.json` in its constructor and returns arrays. Its [public tokenizer API](https://github.com/huggingface/tokenizers.js/blob/4ddbf8ea098418e98f13c2ddcaa61dcee16d0580/src/core/Tokenizer.ts) does not implement padding or truncation.

For our single-sequence WordPiece MiniLM configuration, use the public [postprocessor](https://github.com/huggingface/tokenizers.js/blob/4ddbf8ea098418e98f13c2ddcaa61dcee16d0580/src/core/PostProcessor.ts) and [TemplateProcessing](https://github.com/huggingface/tokenizers.js/blob/4ddbf8ea098418e98f13c2ddcaa61dcee16d0580/src/core/postProcessor/TemplateProcessing.ts) API:

```ts
const post = tokenizer.post_processor;
const overhead = post.post_process([], undefined, true).tokens.length;
const content = tokenizer.tokenize(text, { add_special_tokens: false });
const processed = post.post_process(content.slice(0, maxLength - overhead), undefined, true);
const ids = processed.tokens.map((token) => tokenizer.token_to_id(token));
const typeIds = processed.token_type_ids;
```

Validate the supported model/template and positive token budget first; reject unresolved token IDs. Return the IDs, attention masks and type IDs unpadded, with the model's padding ID as `padId`. `FlagEmbedding.embed()` right-pads each batch to its longest row: IDs with `padId`, attention masks and type IDs with zero. Real token positions receive attention value one. This lets upstream construct the special-token sequence after truncation, preserving `[SEP]` without assuming that slicing a fully encoded row is safe. It uses no private tokenizer methods or recreated WordPiece algorithm.

Keep these existing behaviors deliberately:

- The effective maximum is `min(512, tokenizer_config.model_max_length)`. The model's `tokenizer.json` stores a 128-token truncation setting, which FastEmbed raises to **512**; following it would change existing embeddings. The file's fixed-128 padding setting is ignored: `embed()` pads each batch to its longest row.
- Preserve all five special tokens and their flags from `tokenizer.json`; the MiniLM file contains them. Validate agreement with the special-token map rather than assuming this holds for arbitrary models.
- `embed()` receives unprefixed documents; `queryEmbed()` adds `query: `. FastEmbed selects the **first token's hidden state and normalizes it**, rather than mean-pooling. Changing either behavior would be a separate embedding/index migration.
- Keep 384 dimensions, model/cache location, ONNX input names and int64 tensors, batch order, and the existing unavailable-model fallback. Preserve the archive extraction limits and link rejection.

## Compatibility evidence

Native and JavaScript tokenization matched exactly in 210 comparisons: 70 synthetic strings at maximum lengths 8, 32 and 512. Cases included empty input, code, accents, CJK, Arabic, emoji, control characters, literal special tokens, unknown words and truncation. IDs, attention masks and type IDs matched in both FastEmbed module formats. Three document vectors and one query vector also matched exactly through the same ONNX session, with 384 dimensions and a maximum absolute difference of zero. This covers the MiniLM configuration above, not every possible model or Unicode input.

Padding each batch to its longest row instead of to 512 tokens leaves vectors unchanged within float rounding: texts of 3 to about 360 tokens, embedded alone and together, have cosine similarity 1.0000000 with their 512-padded vectors. Stored vectors therefore need no migration, and a short text runs a short pass instead of a 512-token one.

## Maintenance

[Regression tests](../packages/memory/src/model-tokenizer.test.ts) exercise the adapter's exported interface and public initialization through both FastEmbed formats. Run the memory suite, typechecks and [packaged model checks](packaged-runtime-validation.md) after changing it.

```sh
pnpm --filter @openorc/memory test
pnpm --filter @openorc/memory typecheck
pnpm licenses:check
```

Verify that native tokenizer platform packages remain absent from both lockfile resolution and the packaged artifact. [The notice audit](distribution-notices.md) retains a limitation rule if they are reintroduced. Preserve existing model files, cache behavior, prefix, pooling and normalization; changing them requires a separate index-migration decision.
