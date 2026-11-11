import glob,re,html,sys
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib import instancer
src,out=sys.argv[1],sys.argv[2]
txt=''
for f in glob.glob('web/dist/**/*.html',recursive=True):
    s=open(f).read(); s=re.sub(r'<script.*?</script>|<style.*?</style>|<svg.*?</svg>','',s,flags=re.S); txt+=html.unescape(re.sub(r'<[^>]+>',' ',s))
for f in ['web/assets/dashboard.js','web/assets/quay.js','web/assets/canvas.js','web/layers.mjs']:
    txt+=open(f).read()
base=set(chr(c) for c in range(0x20,0x7f))|set('’‘“”–—…•·×→←↑↓✓©™ ')
chars=''.join(sorted(set(txt)|base))
for name,rng in [('geist',(400,600)),('geist-mono',(400,500))]:
    f=TTFont(f'{src}/{name}-latin.woff2',lazy=False)
    o=subset.Options(); o.flavor=None; o.layout_features=['kern','liga','calt','tnum','ss01','case','zero'] if name=='geist-mono' else ['kern','liga','calt','tnum','case']
    o.name_IDs=['*']; o.notdef_outline=True
    sub=subset.Subsetter(o); sub.populate(text=chars); sub.subset(f)
    f=instancer.instantiateVariableFont(f,{'wght':rng})
    f.flavor='woff2'; f.save(f'{out}/{name}.woff2')
    print(name, len(f.getBestCmap()))
