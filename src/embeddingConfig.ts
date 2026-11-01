/** Keep persisted index identity and the worker's actual inference settings in sync. */
export const MODEL_NAME = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
export const MODEL_REVISION = 'c25a394dd583836952667c12f008335071b3f43d';
export const VECTOR_DIM = 1024;
export const QUERY_INSTRUCTION = 'Instruct: Given a natural language description of code, retrieve the code that implements it\nQuery:';
export const PIPELINE_ID = 'qwen3:last_token:l2:q8:code-query-v1';
