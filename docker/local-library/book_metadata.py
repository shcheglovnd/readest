"""Existing import helpers: sampled book IDs, metadata, covers and signed uploads."""
import base64
import hashlib
import io
import posixpath
from urllib.parse import unquote
import xml.etree.ElementTree as ET
import zipfile

from PIL import Image
import pymupdf
from readest_local import ORIGIN, api

FORMATS = {'.pdf': 'PDF', '.epub': 'EPUB', '.mobi': 'MOBI', '.azw': 'AZW',
           '.azw3': 'AZW3', '.fb2': 'FB2', '.fbz': 'FBZ', '.cbz': 'CBZ'}
pymupdf.TOOLS.mupdf_display_errors(False)
pymupdf.TOOLS.mupdf_display_warnings(False)

def partial_md5(data):
    h = hashlib.md5()
    f = io.BytesIO(data) if isinstance(data,bytes) else open(data,'rb')
    try:
        f.seek(0,2)
        size = f.tell()
        for i in range(-1,11):
            start = 0 if i==-1 else 1024 << (2*i)
            if start >= size: break
            f.seek(start)
            h.update(f.read(min(1024,size-start)))
    finally: f.close()
    return h.hexdigest()

def png(data):
    with Image.open(io.BytesIO(data)) as im:
        im = im.convert('RGB')
        im.thumbnail((600,900))
        output = io.BytesIO()
        im.save(output,format='PNG',optimize=True)
        return output.getvalue()

def texts(root, name):
    return [''.join(el.itertext()).strip() for el in root.iter() if el.tag.rsplit('}',1)[-1]==name and ''.join(el.itertext()).strip()]

def metadata(path):
    title,author = path.stem,''
    meta = {'title':title}
    cover = None
    pages = None
    if path.suffix.lower()=='.pdf':
        with pymupdf.open(path) as doc:
            if doc.needs_pass: raise ValueError('Password-protected PDF')
            if not doc.page_count: raise ValueError('PDF contains no pages')
            pages = doc.page_count
            info = doc.metadata or {}
            meta.update({k:info[k].replace('\x00','') for k in ('title','author','subject') if info.get(k)})
            author = meta.get('author','')
            scale=min(600/doc[0].rect.width,900/doc[0].rect.height)
            cover = doc[0].get_pixmap(matrix=pymupdf.Matrix(scale,scale),alpha=False).tobytes('png')
    elif path.suffix.lower()=='.epub':
        with zipfile.ZipFile(path) as archive:
            container = ET.fromstring(archive.read('META-INF/container.xml'))
            opf_path = next(el.attrib['full-path'] for el in container.iter() if el.tag.endswith('rootfile'))
            opf = ET.fromstring(archive.read(opf_path))
            metadata_el = next(el for el in opf if el.tag.rsplit('}',1)[-1]=='metadata')
            for tag,field in [('title','title'),('creator','author'),('language','language'),('identifier','identifier'),('description','description'),('publisher','publisher'),('date','published')]:
                values = texts(metadata_el,tag)
                if values: meta[field] = values if field in ('author','identifier') else values[0]
            title = meta.get('title') or title
            author = ', '.join(meta.get('author',[]))
            manifest = {el.attrib['id']:el.attrib for el in opf.iter() if el.tag.rsplit('}',1)[-1]=='item'}
            cover_id = next((el.attrib.get('content') for el in metadata_el if el.attrib.get('name')=='cover'),None)
            item = next((a for a in manifest.values() if 'cover-image' in a.get('properties','').split()),None) or manifest.get(cover_id)
            if not item:
                item = next((a for a in manifest.values() if a.get('media-type','').startswith('image/') and 'cover' in a.get('id','').lower()),None)
            if item:
                try: cover = png(archive.read(posixpath.normpath(posixpath.join(posixpath.dirname(opf_path),unquote(item['href'])))))
                except Exception: pass
    elif path.suffix.lower()=='.fb2':
        root = ET.parse(path).getroot()
        info = next((el for el in root.iter() if el.tag.rsplit('}',1)[-1]=='title-info'),root)
        title = (texts(info,'book-title') or [title])[0]
        authors=[]
        for el in info:
            if el.tag.rsplit('}',1)[-1]=='author':
                name=' '.join((texts(el,'first-name')+texts(el,'middle-name')+texts(el,'last-name')))
                if name: authors.append(name)
        author=', '.join(authors)
        meta={'title':title,'author':authors,'language':(texts(info,'lang') or [''])[0]}
        coverpage=next((el for el in info if el.tag.rsplit('}',1)[-1]=='coverpage'),None)
        if coverpage is not None:
            image=next(iter(coverpage),None)
            if image is not None:
                ref=next((v.lstrip('#') for k,v in image.attrib.items() if k.endswith('href')),None)
                binary=next((el for el in root if el.attrib.get('id')==ref),None)
                if binary is not None and binary.text:
                    try: cover=png(base64.b64decode(binary.text))
                    except Exception: pass
    return title.replace('\x00',''),author.replace('\x00',''),meta,cover,pages

def upload(session, path_or_data, name, book_hash):
    size = len(path_or_data) if isinstance(path_or_data,bytes) else path_or_data.stat().st_size
    signed = api(session,'POST','/api/storage/upload',json={'fileName':name,'fileSize':size,'bookHash':book_hash})
    if not any(signed['uploadUrl'].startswith(ORIGIN + prefix) for prefix in ('/readest-files/', '/library-files/')):
        raise ValueError('Refusing upload outside the local Readest bucket')
    # A presigned URL supplies its own authorization; do not attach the account JWT.
    import requests
    data = io.BytesIO(path_or_data) if isinstance(path_or_data,bytes) else open(path_or_data,'rb')
    try:
        try:
            r = requests.put(signed['uploadUrl'],data=data,verify=session.verify,timeout=300)
        except requests.RequestException as error:
            raise RuntimeError('Local S3 request failed: '+type(error).__name__) from None
        if not r.ok: raise RuntimeError(f'Local S3 upload HTTP {r.status_code}')
    finally: data.close()
