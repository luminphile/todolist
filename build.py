#!/usr/bin/env python3
"""把 template.html + 各脚本内联成单文件 index.html。

线上分享链接模式会拦截不带 sharecode 的子资源请求，
所以交付物必须是单一 HTML，不能引用外部 js/css。
"""
import re
import pathlib

base = pathlib.Path(__file__).resolve().parent
tpl = (base / 'template.html').read_text(encoding='utf-8')


def repl(match):
    rel = match.group(1).strip()
    path = base / rel
    if not path.exists():
        raise SystemExit('缺少文件: ' + str(path))
    code = path.read_text(encoding='utf-8')
    # 代码里出现 </script> 会提前闭合内联脚本，需转义
    code = code.replace('</script>', '<\\/script>')
    return '<script>\n' + code + '\n</script>'


out, count = re.subn(r'<!--@INLINE:([^>]+)-->', repl, tpl)
if count != 4:
    raise SystemExit('占位符数量异常: %d' % count)
(base / 'index.html').write_text(out, encoding='utf-8')
print('构建完成: index.html %d 字节' % len(out.encode('utf-8')))
print('外部 script 引用:', re.findall(r'<script src=[^>]+>', out))
