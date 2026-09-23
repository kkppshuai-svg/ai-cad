#!/usr/bin/env python3
"""Batch encoding and decoding for the neural CAD structure VAE."""
import argparse
import json
from pathlib import Path
from structure_vae import StructureVAE


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('operation',choices=['encode','decode','reconstruct'])
    ap.add_argument('--model',required=True);ap.add_argument('--input',required=True);ap.add_argument('--out')
    args=ap.parse_args();runtime=StructureVAE(json.loads(Path(args.model).read_text()))
    data=json.loads(Path(args.input).read_text())
    if args.operation=='encode':
        value=runtime.encode(data).tolist()
    else:
        result=runtime.decode(data if args.operation=='decode' else runtime.encode(data))
        value={'vocabulary':runtime.vocabulary,'numericFeatures':['partCount','jointCount'],**{k:a.tolist() for k,a in result.items()}}
    text=json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n'
    if args.out: Path(args.out).write_text(text,encoding='utf-8')
    else: print(text,end='')

if __name__=='__main__':main()
