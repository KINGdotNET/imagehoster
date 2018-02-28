
import config from 'config'
import {sha1, mhashEncode} from 'app/server/hash'
import {missing, statusError} from 'app/server/utils-koa'
import {waitFor, s3call, s3, getObjectUrl} from 'app/server/amazon-bucket'

import fileType from 'file-type'
import request from 'request'
import sharp from 'sharp'

const {uploadBucket, webBucket, thumbnailBucket} = config
const putOptions = {CacheControl: 'public,max-age=31536000,immutable'}

const TRACE = process.env.STEEMIT_IMAGEPROXY_TRACE || false

const router = require('koa-router')()

// http://localhost:3234/640x480/https://cdn.meme.am/cache/instances/folder136/400x400/67577136.jpg
// http://localhost:3234/0x0/https://cdn.meme.am/cache/instances/folder136/400x400/67577136.jpg
router.get('/:width(\\d+)x:height(\\d+)/:url(.*)', function *() {
    if(missing(this, this.params, 'width')) return
    if(missing(this, this.params, 'height')) return
    if(missing(this, this.params, 'url')) return

    // NOTE: can't use req.params.url -- it doesn't include the query string.
    //   Instead, we take the full request URL and trim everything up to the
    //   start of 'http'. A few edge cases:
    //
    // * query strings
    // originalUrl: /640x480/https://encrypted-tbn2.gstatic.com/images?q=tbn:ANd9GcTZN5Du9Iai_05bMuJrxJuGTfqxNstuOvTP7Mzx-otuUVveeh8D
    // params.url:  https://encrypted-tbn2.gstatic.com/images
    // expect url:  https://encrypted-tbn2.gstatic.com/images?q=tbn:ANd9GcTZN5Du9Iai_05bMuJrxJuGTfqxNstuOvTP7Mzx-otuUVveeh8D
    //
    // * encoded parts
    // originalUrl: /640x480/https://vignette1.wikia.nocookie.net/villains/images/9/9c/Monstro_%28Disney%29.png
    // params.url:  https://vignette1.wikia.nocookie.net/villains/images/9/9c/Monstro_(Disney).png
    // expect url:  https://vignette1.wikia.nocookie.net/villains/images/9/9c/Monstro_%28Disney%29.png
    let url = this.request.originalUrl.substring(this.request.originalUrl.indexOf('http'))
    url = url.replace('steemit.com/ipfs/', 'ipfs.pics/ipfs/')

    if (url.match(/^https?:\/\//) === null) {
        statusError(this, 400, 'Bad Request')
        return
    }

    let targetWidth = parseInt(this.params.width, 10)
    let targetHeight = parseInt(this.params.height, 10)

    // Force a thumnail until the web urls are requesting 1680x8400 instead of 0x0..  The thumnail fixes image rotation.
    if(targetWidth === 0 && targetHeight === 0) {
        targetWidth = 1680
        targetHeight = 8400
    }

    const fullSize = targetWidth === 1680 && targetHeight === 8400

    // image blacklist
    const blacklist = [
        'https://pbs.twimg.com/media/CoN_sC6XEAE7VOB.jpg:large',
        'https://ipfs.pics/ipfs/QmXz6jNVkH2FyMEUtXSAvbPN4EwG1uQJzDBq7gQCJs1Nym',
        'http://customerceobook.com/wp-content/uploads/2012/12/noahpozner420peoplemagazine.jpg',
        'http://reseauinternational.net/wp-content/uploads/2015/01/Sans-titre.jpg',
        'http://edge.liveleak.com/80281E/ll_a_u/thumbs/2015/Jan/1/67f252081582_sf_3.jpg',
        'http://st-listas.20minutos.es/images/2016-03/408680/list_640px.jpg?1458217580',
        'http://i1272.photobucket.com/albums/y391/mtgmtg_2012/mtgmtg_2012006/8575314572_bb657293cd_b_zps4d684b87.jpg',
        'http://img09.deviantart.net/c561/i/2015/005/4/b/psychedeliczen_id_by_psychedeliczen-d63npyv.jpg',
        'https://thumbs.gfycat.com/FakeWellwornAlaskanmalamute-size_restricted.gif',
        'https://2.bp.blogspot.com/-fabo0S0G2PQ/WA0g5Uo7mdI/AAAAAAAAGVU/uA0rRKzmvKoFdgxzUEV6SkgAS0turqPHwCEw/s1600/Mating%2Bswarm.jpg',
        'https://i.blogs.es/05aca7/pyriformis13-xl/450_1000.jpg',
        'https://myrmecos.files.wordpress.com/2010/04/imparis14.jpg?w=1400',
        'http://savepic.ru/11219364.jpg',
        'https://d2r55xnwy6nx47.cloudfront.net/uploads/2014/04/Eciton7j-Alex-Wild-Web.jpg',
        'http://scienceblogs.com/photosynthesis/wp-content/blogs.dir/309/files/2012/04/i-85574ee42f4fc75ae3bb45e4f2bb998b-fly1.jpg',
        'http://bogleech.com/nature/fly-microdon.jpg',
        'https://photos.smugmug.com/Ants/Taxonomic-List-of-Ant-Genera/Lasius/i-gj7LzPm/0/XL/flavus5-XL.jpg',
        'https://2.bp.blogspot.com/-76LDew482u8/WgGFasOlXtI/AAAAAAAANfU/CHw2LZO27Y04wRPuTjtqc9ajXDNurOuyACLcBGAs/s1600/Cephalotes%2Bporrrasi%2B2.jpg',
        'https://3.bp.blogspot.com/-HaidYOAZcRo/WgGFOjEJqJI/AAAAAAAANfQ/jKm7VXb7_08gqJPDCNsHkM2fxaiKeQsGACLcBGAs/s1600/Cephalotes%2Bporrasi%2B1.jpg',
        'https://img.esteem.ws/lk2hsivn08.jpg',
        'http://www.quo.es/var/quo/storage/images/naturaleza/hormigas-de-fuego/1352329-1-esl-ES/las-hormigas-de-fuego-quieren-invadir-japon_ampliacion.jpg',
        'http://www.ecuavisa.com/sites/default/files/fotos/2017/01/04/hormiga.jpg',
        'http://escolakids.uol.com.br/public/upload/image/variedades%20de%20formiga.jpg',
        'https://s9.postimg.org/6xge0h2gv/image.jpg',
        'http://avivas.ru/img/topic/23850/20.jpg',
        'https://i.imgur.com/VKdTkV8.jpg',
        'http://lifeinjapan.ru/upload/posts/mur2707.jpg',
        'https://encrypted-tbn2.gstatic.com/images?q=tbn:ANd9GcRamUeYdOkZuUhgTr9drnicux-spHCow9d5slH8xeldMu1ODbi9JOl9b2R5Og',
    ];
    if(blacklist.includes(url)) {
        statusError(this, 400, 'Bad Request')
        return
    }

    // referer blacklist
    const ref = this.request.headers.referer;
    if(ref && ref.match(/^https:\/\/www\.wholehk\.com/)) {
        statusError(this, 403, 'Forbidden')
        return
    }

    // Uploaded images were keyed by the hash of the image data and store these in the upload bucket.  
    // The proxy images use the hash of image url and are stored in the web bucket.
    const isUpload = simpleHashRe.test(url) // DQm...
    const Key = isUpload ? url.match(simpleHashRe)[0] : urlHash(url) // UQm...
    const Bucket = isUpload ? uploadBucket : webBucket
    const originalKey = {Bucket, Key}
    const webBucketKey = {Bucket: webBucket, Key}

    // This lets us remove images even if the s3 bucket cache is public,immutable
    // Clients will have to re-evaulate the 302 redirect every day
    this.status = 302
    this.set('Cache-Control', 'public,max-age=86400')

    const resizeRequest = targetWidth !== 0 || targetHeight !== 0
    if(resizeRequest) { // This is always true...
        const resizedKey = Key + `_${targetWidth}x${targetHeight}`
        const thumbnailKey = {Bucket: thumbnailBucket, Key: resizedKey}

        const hasThumbnail = (yield s3call('headObject', thumbnailKey)) != null
        if(TRACE) console.log('image-proxy -> resize has thumbnail', hasThumbnail)

        if(hasThumbnail) {
            const params = {Bucket: thumbnailBucket, Key: resizedKey, Expires: 60}
            if(TRACE) console.log('image-proxy -> thumbnail redirect')
            this.redirect(getObjectUrl(params))
            return
        }

        // Sharp can't resize all frames in the animated gif .. just return the full image
        // http://localhost:3234/1680x8400/http://mashable.com/wp-content/uploads/2013/07/ariel.gif
        if(fullSize) { // fullSize is used to show animations in the full-post size only
            // Case 1 of 2: re-fetching
            const imageHead = yield fetchHead(this, Bucket, Key, url, webBucketKey)
            if(imageHead && imageHead.ContentType === 'image/gif') {
                if(TRACE) console.log('image-proxy -> gif redirect (animated gif work-around)', JSON.stringify(imageHead, null, 0))
                this.redirect(getObjectUrl(imageHead.headKey))
                return
            }
            // See below, one more animated gif work-around ...
        }

        // no thumbnail, fetch and cache
        const imageResult = yield fetchImage(this, Bucket, Key, url, webBucketKey)
        if(!imageResult) {
            return
        }

        if(fullSize && imageResult.ContentType === 'image/gif') {
            // Case 2 of 2: initial fetch
            yield waitFor('objectExists', webBucketKey)
            if(TRACE) console.log('image-proxy -> new gif redirect (animated gif work-around)', JSON.stringify(webBucketKey, null, 0))
            this.redirect(getObjectUrl(webBucketKey))
            return
        }

        try {
            if(TRACE) console.log('image-proxy -> prepare thumbnail')
            const thumbnail = yield prepareThumbnail(imageResult.Body, targetWidth, targetHeight)

            if(TRACE) console.log('image-proxy -> thumbnail save', JSON.stringify(thumbnailKey, null, 0))
            yield s3call('putObject', Object.assign({}, thumbnailKey, thumbnail, putOptions))
            yield waitFor('objectExists', thumbnailKey)

            if(TRACE) console.log('image-proxy -> thumbnail redirect', JSON.stringify(thumbnailKey, null, 0))
            this.redirect(getObjectUrl(thumbnailKey))
        } catch(error) {
            console.error('image-proxy resize error', this.request.originalUrl, error, error ? error.stack : undefined)
            yield waitFor('objectExists', webBucketKey)
            if(TRACE) console.log('image-proxy -> resize error redirect', url)
            this.redirect(getObjectUrl(webBucketKey))
        }
        return
    }

    // A full size image
    throw 'NEVER REACHED'

    const hasOriginal = !!(yield s3call('headObject', originalKey))
    if(hasOriginal) {
        if(TRACE) console.log('image-proxy -> original redirect', JSON.stringify(originalKey, null, 0))
        const signedUrl = s3.getSignedUrl('getObject', originalKey)
        this.redirect(signedUrl)
        return
    }

    const imageResult = yield fetchImage(this, Bucket, Key, url, webBucketKey)
    if(!imageResult) {
        return
    }

    if(TRACE) console.log('image-proxy -> original save')
    yield s3call('putObject', Object.assign({}, webBucketKey, imageResult))
    yield waitFor('objectExists', webBucketKey)

    if(TRACE) console.log('image-proxy -> original redirect', JSON.stringify(webBucketKey, null, 0))
    const signedUrl = s3.getSignedUrl('getObject', webBucketKey)
    this.redirect(signedUrl)
})

function* fetchHead(ctx, Bucket, Key, url, webBucketKey) {
    const headKey = {Bucket, Key}
    let head = yield s3call('headObject', headKey)
    if(!head && Bucket === uploadBucket) {
        // The url appeared to be in the Upload bucket but was not,
        // double-check the webbucket to be sure.
        head = yield s3call('headObject', webBucketKey)
        if(TRACE) console.log('image-proxy -> fetch image head', !!head, JSON.stringify(webBucketKey, null, 0))
        if(!head)
            return null

        return {headKey: webBucketKey, ContentType: head.ContentType}        
    } else {
        if(TRACE) console.log('image-proxy -> fetch image head', !!head, JSON.stringify(headKey, null, 0))
        if(!head)
            return null

        return {headKey, ContentType: head.ContentType}
    }
}

function* fetchImage(ctx, Bucket, Key, url, webBucketKey) {
    let img = yield s3call('getObject', {Bucket, Key})
    if(!img && Bucket === uploadBucket) {
        // The url appeared to be in the Upload bucket but was not,
        // double-check the webbucket to be sure.
        img = yield s3call('getObject', webBucketKey)
        if(TRACE) console.log('image-proxy -> fetch image cache', !!img, JSON.stringify(webBucketKey, null, 0))
    } else {
        if(TRACE) console.log('image-proxy -> fetch image cache', !!img, JSON.stringify({Bucket, Key}, null, 0))
    }
    if(img) {
        const {Body, ContentType} = img
        return {Body, ContentType}
    }
    const opts = {
        url: url,
        timeout: 10000,
        followRedirect: true,
        maxRedirects: 2,
        rejectUnauthorized: false, // WARNING
        encoding: null
    }
    const imgResult = yield new Promise((resolve) => {
        request(opts, (error, response, imageBuffer) => {
            if (imageBuffer) {
                const ftype = fileType(imageBuffer)
                if(!ftype || !/^image\/(gif|jpeg|png)$/.test(ftype.mime)) {
                    statusError(ctx, 400, 'Supported image formats are: gif, jpeg, and png')
                    resolve()
                    return
                }
                const {mime} = ftype
                resolve({Body: imageBuffer, ContentType: mime})
                return
            }
            console.log('404 Not Found', url);
            statusError(ctx, 404, 'Not Found')
            resolve()
        })
    })
    if(imgResult) {
        yield s3call('putObject', Object.assign({}, webBucketKey, imgResult, putOptions))
    }
    return imgResult
}

function* prepareThumbnail(imageBuffer, targetWidth, targetHeight) {
    const image = sharp(imageBuffer).withMetadata().rotate();
    const md = yield image.metadata()
    const geo = calculateGeo(md.width, md.height, targetWidth, targetHeight)

    let i = image.resize(geo.width, geo.height)
    let type = md.format
    if(md.format === 'gif') {
        // convert animated gifs into a flat png
        i = i.toFormat('png')
        type = 'png'
    }
    const Body = yield i.toBuffer()
    return {Body, ContentType: `image/${type}`}
}

function calculateGeo(origWidth, origHeight, targetWidth, targetHeight) {
    // Default ratio. Default crop.
    const origRatio  = (origHeight !== 0 ? (origWidth / origHeight) : 1)

    // Fill in missing target dims.
    if (targetWidth === 0 && targetHeight === 0) {
        targetWidth  = origWidth;
        targetHeight = origHeight;
    } else if (targetWidth === 0) {
        targetWidth  = Math.round(targetHeight * origRatio);
    } else if (targetHeight === 0) {
        targetHeight = Math.round(targetWidth / origRatio);
    }

    // Constrain target dims.
    if(targetWidth > origWidth)   targetWidth  = origWidth;
    if(targetHeight > origHeight) targetHeight = origHeight;

    const targetRatio = targetWidth / targetHeight;
    if (targetRatio > origRatio) {
        // max out height, and calc a smaller width
        targetWidth = Math.round(targetHeight * origRatio);
    } else if (targetRatio < origRatio) {
        // max out width, calc a smaller height
        targetHeight = Math.round(targetWidth / origRatio);
    }

    // console.log('Original: ' + origWidth + 'x' + origHeight + ' -> Target: ' + targetWidth + 'x' + targetHeight);

    return {
        width:  targetWidth,
        height: targetHeight,
    };
}

const simpleHashRe = /DQm[a-zA-Z0-9]{38,46}/
const urlHash = url => 'U' + mhashEncode(sha1(url), 'sha1')

export default router.routes()