#!/usr/bin/env python3
"""Batch descriptor encoder, decoder, reconstruction and retrieval CLI."""
import argparse
import json
from pathlib import Path
from train_brep_vae import load_model
from vae_runtime import VaeRuntime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['encode', 'decode', 'reconstruct', 'search'])
    parser.add_argument('--model', required=True)
    parser.add_argument('--input', required=True, help='JSON array of vectors (latents for decode)')
    parser.add_argument('--out', help='Output JSON; defaults to stdout')
    parser.add_argument('--limit', type=int, default=5)
    parser.add_argument('--geometry-weight', type=float, default=0.5)
    args = parser.parse_args()
    runtime = VaeRuntime(load_model(args.model))
    data = json.loads(Path(args.input).read_text(encoding='utf-8'))
    if args.operation == 'search':
        result = runtime.search(data, args.limit, args.geometry_weight)
    else:
        result = getattr(runtime, args.operation)(data).tolist()
    output = json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2)+'\n'
    if args.out:
        Path(args.out).write_text(output, encoding='utf-8')
    else:
        print(output, end='')

if __name__ == '__main__':
    main()
