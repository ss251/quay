import sys
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib import instancer
U = list(range(0x20,0x7f)) + [0xa0,0xa9,0xb7,0xd7,0x2013,0x2014,0x2018,0x2019,0x201c,0x201d,0x2026,0x2191,0x2193,0x2212,0x2122,0x2248,0x2192,0x2190]
def make(src, out, limits=None, rename=None, features=("kern","liga","calt","tnum","case","zero")):
    f = TTFont(src, lazy=False)
    opts = subset.Options(); opts.flavor='woff2'; opts.layout_features=list(features); opts.name_IDs=[0,1,2,3,4,5,6,13,14]; opts.notdef_outline=True; opts.hinting=False; opts.desubroutinize=True
    s = subset.Subsetter(opts); s.populate(unicodes=U); s.subset(f)
    if limits and 'fvar' in f:
        f = instancer.instantiateVariableFont(f, limits, updateFontNames=False)
    if rename:
        n=f['name']
        for rec in list(n.names):
            if rec.nameID in (1,3,4,6,16,17,21,22): n.removeNames(nameID=rec.nameID)
        n.setName(rename,1,3,1,0x409); n.setName('Regular',2,3,1,0x409); n.setName(rename,4,3,1,0x409); n.setName(rename.replace(' ','')+'-Regular',6,3,1,0x409); n.setName(rename+' subset for quay',3,3,1,0x409)
    f.flavor='woff2'; f.save(out)
    import os; print(out, os.path.getsize(out))
if __name__=='__main__':
    import json
    make(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]) if len(sys.argv)>3 and sys.argv[3] else None, sys.argv[4] if len(sys.argv)>4 else None)
