const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { FormData } = require('form-data');

const app = express();
const port = process.env.SERVER_PORT || process.env.PORT || 3000;

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "bfcffccc6ed4441b965cd81b10ddb561";
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "311427216ab64de1b3c0150ea43fd2c4";

let accessToken = null;
let tokenExpire = 0;

const youtubeHeaders = {
  "accept": "*/*",
  "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "sec-ch-ua": "\"Not A(Brand\";v=\"8\", \"Chromium\";v=\"132\"",
  "sec-ch-ua-mobile": "?1",
  "sec-ch-ua-platform": "\"Android\"",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
  "Referer": "https://id.ytmp3.mobi/",
  "Referrer-Policy": "strict-origin-when-cross-origin"
};

class SpotMate {
  constructor() {
    this._cookie = null;
    this._token = null;
  }

  async _visit() {
    try {
      const response = await axios.get('https://spotmate.online/en', {
        headers: {
          'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36',
        },
      });

      const setCookieHeader = response.headers['set-cookie'];
      if (setCookieHeader) {
        this._cookie = setCookieHeader
          .map((cookie) => cookie.split(';')[0])
          .join('; ');
      }

      const $ = cheerio.load(response.data);
      this._token = $('meta[name="csrf-token"]').attr('content');

      if (!this._token) {
        throw new Error('Token CSRF tidak ditemukan.');
      }

      return true;
    } catch (error) {
      throw new Error(`Gagal mengunjungi halaman: ${error.message}`);
    }
  }

  async info(spotifyUrl) {
    if (!this._cookie || !this._token) {
      await this._visit();
    }

    try {
      const response = await axios.post(
        'https://spotmate.online/getTrackData',
        { spotify_url: spotifyUrl },
        {
          headers: this._getHeaders(),
        }
      );

      return response.data;
    } catch (error) {
      throw new Error(`Gagal mendapatkan info track: ${error.message}`);
    }
  }

  async convert(spotifyUrl) {
    if (!this._cookie || !this._token) {
      await this._visit();
    }

    try {
      const response = await axios.post(
        'https://spotmate.online/convert',
        { urls: spotifyUrl },
        {
          headers: this._getHeaders(),
        }
      );

      return response.data;
    } catch (error) {
      throw new Error(`Gagal mengonversi track: ${error.message}`);
    }
  }

  async download(spotifyUrl) {
    try {
      const trackInfo = await this.info(spotifyUrl);
      const convertResult = await this.convert(spotifyUrl);

      return {
        info: trackInfo,
        download: convertResult
      };
    } catch (error) {
      throw new Error(`Gagal mendapatkan data download: ${error.message}`);
    }
  }

  clear() {
    this._cookie = null;
    this._token = null;
  }

  _getHeaders() {
    return {
      'authority': 'spotmate.online',
      'accept': '*/*',
      'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'content-type': 'application/json',
      'cookie': this._cookie,
      'origin': 'https://spotmate.online',
      'referer': 'https://spotmate.online/en',
      'sec-ch-ua': '"Not A(Brand";v="8", "Chromium";v="132"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36',
      'x-csrf-token': this._token,
    };
  }
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpire) return accessToken;

  const res = await axios.post(
    "https://accounts.spotify.com/api/token",
    "grant_type=client_credentials",
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      },
    }
  );

  accessToken = res.data.access_token;
  tokenExpire = Date.now() + res.data.expires_in * 1000;
  return accessToken;
}

async function spotifySearch(query, limit = 10) {
  const token = await getAccessToken();

  const res = await axios.get("https://api.spotify.com/v1/search", {
    headers: { Authorization: `Bearer ${token}` },
    params: { q: query, type: "track", limit },
  });

  return res.data.tracks.items.map(track => ({
    id: track.id,
    title: track.name,
    artist: track.artists.map(a => a.name).join(", "),
    album: track.album.name,
    duration_ms: track.duration_ms,
    preview_url: track.preview_url,
    spotify_url: track.external_urls.spotify,
    image: track.album.images[0]?.url,
  }));
}

async function youtubeSearch(query) {
  try {
    const results = await yts(query);
    return results.all;
  } catch (error) {
    throw new Error(`Error searching YouTube: ${error.message}`);
  }
}

async function youtubeDownload(url, format = 'mp3') {
  try {
    const initial = await fetch(`https://d.ymcdn.org/api/v1/init?p=y&23=1llum1n471&_=${Math.random()}`, { headers: youtubeHeaders });
    const init = await initial.json();

    const id = url.match(/(?:youtu\.be\/|youtube\.com\/(?:.*v=|.*\/|.*embed\/))([^&?/]+)/)?.[1];
    
    if (!id) {
      throw new Error('Invalid YouTube URL');
    }

    let convertURL = init.convertURL + `&v=${id}&f=${format}&_=${Math.random()}`;
    const converts = await fetch(convertURL, { headers: youtubeHeaders });
    const convert = await converts.json();

    let info = {};
    for (let i = 0; i < 10; i++) {
      let j = await fetch(convert.progressURL, { headers: youtubeHeaders });
      info = await j.json();
      if (info.progress == 3) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return {
      url: convert.downloadURL,
      title: info.title,
      format: format
    };
  } catch (error) {
    throw new Error(`Error downloading YouTube: ${error.message}`);
  }
}

async function txt2anm(prompt) {
  const BOUNDARY = '----WebKitFormBoundary' + Math.random().toString(16).substr(2);
  
  const headers = {
    'authority': 'api.remaker.ai',
    'accept': '*/*',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'authorization': '',
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    'origin': 'https://remaker.ai',
    'product-code': '067003',
    'product-serial': '61b70a3848b1d260c765eac380d9da43',
    'referer': 'https://remaker.ai/',
    'sec-ch-ua': '"Chromium";v="139", "Not;A=Brand";v="99"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36'
  };

  const body = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="style"\r\n\r\nanime\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="aspect_ratio"\r\n\r\n1:1\r\n--${BOUNDARY}--\r\n`;

  const createResponse = await fetch('https://api.remaker.ai/api/pai/v4/ai-anime/create-job', {
    method: 'POST',
    headers,
    body
  });

  const createData = await createResponse.json();
  const jobId = createData.result.job_id;

  const getJobHeaders = {
    'authority': 'api.remaker.ai',
    'accept': '*/*',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'authorization': '',
    'origin': 'https://remaker.ai',
    'product-code': '067003',
    'referer': 'https://remaker.ai/',
    'sec-ch-ua': '"Chromium";v="139", "Not;A=Brand";v="99"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36'
  };

  for (let i = 0; i < 15; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const statusResponse = await fetch(`https://api.remaker.ai/api/pai/v4/ai-anime/get-job/${jobId}`, {
      headers: getJobHeaders
    });
    
    const statusData = await statusResponse.json();
    
    if (statusData.result?.output && statusData.result.output.length > 0) {
      return statusData.result.output[0];
    }
  }
}

async function generateImage(imgUrl) {
  let uploadedImageUrl = imgUrl;
  
  if (!imgUrl.startsWith('http')) {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(imgUrl));
    
    const uploadResponse = await axios.post('https://vondyapi-proxy.com/files/', formData, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
        ...formData.getHeaders()
      }
    });
    
    uploadedImageUrl = uploadResponse.data.fileUrl || uploadResponse.data.data?.fileUrl;
  }

  const conversationData = {
    messages: [
      {
        sender: "user",
        name: "You",
        message: `Create a commercialized figure of the character in the illustration, in a realistic style and environment. Place the figure on a computer desk, using a circular transparent acrylic base without any text. On the computer screen, display the ZBrush modeling process of the figure. Next to the computer screen, place a BANDAI-style toy packaging box printed with the original artwork. @@hidden {} Reference images for "inputImageUrl": [Image 1]: ${uploadedImageUrl} @@hidden`,
        files: [
          {
            type: "image_url",
            image_url: {
              url: uploadedImageUrl
            }
          }
        ],
        image: null,
        type: 1
      }
    ]
  };

  const conversationResponse = await axios.post('https://vondyapi-proxy.com/bot/4d2da86f-d279-4425-8446-851f935c40f1/conversations/', conversationData, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      'Referer': 'https://www.vondy.com/ai-photo-generator-image-to-image--oev9VhNA?lc=5'
    }
  });

  const conversationId = conversationResponse.data.data?.id;

  const imageGenerationData = {
    model: "text-davinci-003",
    maxTokens: 3000,
    input: "mBn00gqQNYCVaFrtprf04Y41pGZ2xoR2oBI1r+h5LLmXGdv/xRCALmS3H6DBCdP1VsTpfXngY1BQhsfTq6rUna30E7uleY6aSbfNRc292LiCq1Q522sh0C0//DshIynJhCWTkEYKWhgyhtKQdPmPbUxC92bAfU4Royr6aaipcL+nTqie3cdscS7f2uBiHO53YxKFKhUb4Q8FNarEJLrUHIFQ+4GeslATgD/NZFak9OC3Vbnl/r09knYHInkAjeGx2uX/5qD0c6P0whSDS/ZVUqjWOiw6pEbsyQORkSe0ccfYmJlTXiE627PQx5d3+xFiL7PPOEG8uQ1ywtfBHghPV+TcxsmoMLdUmmymqGo0+FoIuv5PAUeQwqgaRYMYpaj0y2RTstl9kgnJlhnFCe08dXKLr8hDThSinEoNDFgyt5RJ8nlqWunowtfQ/UNWke8vZ0lq7BS6vZh16llBiDUMkfSs8Gom9i3X/LF1ZPrznysfZxO0+PMxRdv8YSvvKLjFhjlXCMzvn3Hjobpynk5RTbc2Um1q+ypGzeLPVIsKSis+BKLwvZpLXF9OdMiyeejU1N9aKHrP+j0gq4s283/7zMvhdTAS/HGuLZNfQRJ3Hp9q1WZWazch++EoMEJ4lovTfugNMP/G9XeYsJ8QtX1Fl2u7Z46F0Favilxgii9cu9M=",
    temperature: 0.5,
    e: true,
    summarizeInput: true,
    inHTML: false,
    size: "1024x1024",
    numImages: 1,
    useCredits: false,
    titan: false,
    quality: "standard",
    embedToken: null,
    edit: "Create a commercialized figure of the character in the illustration, in a realistic style and environment. Place the figure on a computer desk, using a circular transparent acrylic base without any text. On the computer screen, display the ZBrush modeling process of the figure. Next to the computer screen, place a BANDAI-style toy packaging box printed with the original artwork.",
    inputImageUrl: uploadedImageUrl,
    seed: Math.floor(Math.random() * 1000000),
    similarityStrength: 0.8084920830340128,
    flux: true,
    pro: false,
    face: false,
    useGPT: false
  };

  const imageResponse = await axios.post('https://vondyapi-proxy.com/images/', imageGenerationData, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
    }
  });

  const generatedImageUrl = imageResponse.data.data?.[0] || imageResponse.data;

  const updateData = {
    messages: [
      {
        sender: "user",
        name: "You",
        message: `Create a commercialized figure of the character in the illustration, in a realistic style and environment. Place the figure on a computer desk, using a circular transparent acrylic base without any text. On the computer screen, display the ZBrush modeling process of the figure. Next to the computer screen, place a BANDAI-style toy packaging box printed with the original artwork. @@hidden {} Reference images for "inputImageUrl": [Image 1]: ${uploadedImageUrl} @@hidden`,
        files: [
          {
            type: "image_url",
            image_url: {
              url: uploadedImageUrl
            }
          }
        ],
        image: null,
        type: 1
      },
      {
        sender: "bot",
        name: "Ai Photo Generator Image To Image",
        message: `@@ImgGen { 
  "quality":"standard", 
  "edit":"Create a commercialized figure of the character in the illustration, in a realistic style and environment. Place the figure on a computer desk, using a circular transparent acrylic base without any text. On the computer screen, display the ZBrush modeling process of the figure. Next to the computer screen, place a BANDAI-style toy packaging box printed with the original artwork.", 
  "inputImageUrl": "${uploadedImageUrl}" 
}
A commercialized figure based on the reference image, displayed on a computer desk with a circular transparent acrylic base. The computer screen shows the ZBrush modeling process of the figure. Next to the screen is a BANDAI-style toy packaging box featuring the original artwork. The overall style is realistic with detailed rendering of the figure and environment.
@@ImgGen`,
        type: 1,
        title: "Ai Photo Generator Image To Image"
      }
    ]
  };

  await axios.put(`https://vondyapi-proxy.com/bot/conversations/${conversationId}/`, updateData, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
    }
  });

  return {
    generatedImageUrl: generatedImageUrl,
    uploadedImageUrl: uploadedImageUrl,
    conversationId: conversationId,
    message: 'Image generated successfully'
  };
}

async function xnxxdl(URL) {
  return new Promise(async (resolve, reject) => {
    await fetch(`${URL}`, {method: 'get'})
	.then(res => res.text())
	.then(res => {
	  let $ = cheerio.load(res, {
		xmlMode: false
	  });
	  
	  const title = $('meta[property="og:title"]').attr('content');
	  const duration = $('meta[property="og:duration"]').attr('content');
	  const image = $('meta[property="og:image"]').attr('content');
	  const videoType = $('meta[property="og:video:type"]').attr('content');
	  const videoWidth = $('meta[property="og:video:width"]').attr('content');
	  const videoHeight = $('meta[property="og:video:height"]').attr('content');
	  const info = $('span.metadata').text();
	  const videoScript = $('#video-player-bg > script:nth-child(6)').html();
	  const files = {
		low: (videoScript.match('html5player.setVideoUrlLow\\(\'(.*?)\'\\);') || [])[1],
		high: videoScript.match('html5player.setVideoUrlHigh\\(\'(.*?)\'\\);' || [])[1],
		HLS: videoScript.match('html5player.setVideoHLS\\(\'(.*?)\'\\);' || [])[1],
		thumb: videoScript.match('html5player.setThumbUrl\\(\'(.*?)\'\\);' || [])[1],
		thumb69: videoScript.match('html5player.setThumbUrl169\\(\'(.*?)\'\\);' || [])[1],
		thumbSlide: videoScript.match('html5player.setThumbSlide\\(\'(.*?)\'\\);' || [])[1],
		thumbSlideBig: videoScript.match('html5player.setThumbSlideBig\\(\'(.*?)\'\\);' || [])[1],
	  };
	  resolve({
		result: {
		  title,
		  url: URL,
		  duration,
		  image,
		  videoType,
		  videoWidth,
		  videoHeight,
		  info,
		  files
		}
	  })
    })
	.catch(err => reject({code: 503, status: false, result: err }))
  })
}

async function xnxxs(query) {
  return new Promise(async (resolve, reject) => {
	const baseurl = 'https://www.xnxx.com'
	await fetch(`${baseurl}/search/${query}/${Math.floor(Math.random() * 3) + 1}`, {method: 'get'})
	  .then(res => res.text())
	  .then(res => {
		let $ = cheerio.load(res, {
		  xmlMode: false
		});
		let title = [];
		let url = [];
		let desc = [];
		let results = [];

		$('div.mozaique').each(function(a, b) {
		  $(b).find('div.thumb').each(function(c, d) {
			url.push(baseurl+$(d).find('a').attr('href').replace("/THUMBNUM/", "/"))
		  })
		})
		
		$('div.mozaique').each(function(a, b) {
		  $(b).find('div.thumb-under').each(function(c, d) {
			desc.push($(d).find('p.metadata').text())
			$(d).find('a').each(function(e,f) {
			  title.push($(f).attr('title'))
			})
		  })
		})
		
		for (let i = 0; i < title.length; i++) {
		  results.push({
			title: title[i],
			info: desc[i],
			link: url[i]
		  })
		}
		resolve({
		  result: results
		})
	  })
	.catch(err => reject({code: 503, status: false, result: err }))
  })
}

async function nekos(query) {
  const searchUrl = `https://nekopoi.care/search/${encodeURIComponent(query)}`;
  const { data: html } = await axios.get(searchUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 15; 23124RA7EO Build/AQ3A.240829.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.7499.35 Mobile Safari/537.36" }
  });
  const $ = cheerio.load(html);
  const results = [];

  $("div.result ul li").each((i, li) => {
    const el = $(li);
    const aTag = el.find("h2 > a");
    const title = aTag.text().trim();
    const link = aTag.attr("href");
    let duration = null;
    el.find("div.desc p").each((i, p) => {
      const pText = $(p).text();
      if (/Duration\s*:/i.test(pText) || /Durasi\s*:/i.test(pText)) {
        duration = pText.replace(/Duration\s*:\s*/i, "").replace(/Durasi\s*:\s*/i, "").trim();
        return false;
      }
    });
    results.push({ title, link, duration });
  });

  for (let item of results) {
    try {
      const { data: detailHtml } = await axios.get(item.link, {
        headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 15; 23124RA7EO Build/AQ3A.240829.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.7499.35 Mobile Safari/537.36" }
      });
      const $$ = cheerio.load(detailHtml);
      const streamIds = ["#stream3", "#stream2", "#stream1"];
      let videoSrc = null;
      for (const id of streamIds) {
        const iframe = $$(id + " iframe.vids");
        if (iframe.length) {
          videoSrc = iframe.attr("src");
          if (videoSrc) break;
        }
      }
      item.videoSrc = videoSrc || null;
    } catch (e) {
      item.videoSrc = null;
    }
  }

  return results;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

const uploadFolder = './uploads';
if (!fs.existsSync(uploadFolder)) {
    fs.mkdirSync(uploadFolder);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = crypto.randomBytes(3).toString('hex').toLowerCase();
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Hanya file gambar yang diizinkan!'), false);
  }
};

const upload = multer({ 
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter
});

app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Tidak ada file yang diunggah' });
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const imageUrl = `${baseUrl}/uploads/${req.file.filename}`;

  res.json({
    message: 'Upload berhasil!',
    imageUrl: imageUrl,
    filename: req.file.filename,
    size: req.file.size + ' bytes'
  });
});

app.get('/api/spotify/search', async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.json({
      status: false,
      creator: '7eppeli.XzC',
      message: 'Query parameter is required'
    });
  }

  try {
    const resultSearch = await spotifySearch(query);
      
    const spotMate = new SpotMate();
    const result = await spotMate.download(resultSearch[0].spotify_url);
    spotMate.clear();
      
    res.json({
      status: true,
      creator: '7eppeli.XzC',
      result: result.download
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      creator: '7eppeli.XzC',
      message: error.message
    });
  }
});

app.get('/api/spotify/info', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      status: false,
      creator: '7eppeli.XzC',
      message: 'URL parameter is required'
    });
  }

  const spotMate = new SpotMate();

  try {
    const trackInfo = await spotMate.info(url);
    spotMate.clear();

    return res.status(200).json({
      status: true,
      creator: '7eppeli.XzC',
      data: trackInfo
    });
  } catch (error) {
    spotMate.clear();

    return res.status(500).json({
      status: false,
      creator: '7eppeli.XzC',
      message: error.message
    });
  }
});

app.get('/api/spotify/convert', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      status: false,
      creator: '7eppeli.XzC',
      message: 'URL parameter is required'
    });
  }

  const spotMate = new SpotMate();

  try {
    const convertResult = await spotMate.convert(url);
    spotMate.clear();

    return res.status(200).json({
      status: true,
      creator: '7eppeli.XzC',
      data: convertResult
    });
  } catch (error) {
    spotMate.clear();

    return res.status(500).json({
      status: false,
      creator: '7eppeli.XzC',
      message: error.message
    });
  }
});

app.get('/api/youtube/search', async (req, res) => {
  try {
    const { query, format } = req.query;
    
    if (!query || query.trim() === '') {
      return res.status(400).json({
        status: false,
        creator: '7eppeli.XzC',
        message: 'Query parameter is required'
      });
    }
    
    const results = await youtubeSearch(query);
      
    const downloadFormat = format && (format === 'mp3' || format === 'mp4') ? format : 'mp3';

    const result = await youtubeDownload(results[1].url, downloadFormat);

    res.status(200).json({
      status: true,
      creator: '7eppeli.XzC',
      query,
      result
    });

  } catch (error) {
    res.status(500).json({
      status: false,
      creator: '7eppeli.XzC',
      message: error.message || 'Internal server error'
    });
  }
});

app.get('/api/text2/anime', async (req, res) => {
  try {
    const { query } = req.query;
    
    let count;
    if (!query || query.trim() === '') {
      return res.status(400).json({
        status: false,
        creator: '7eppeli.XzC',
        message: 'Query parameter is required'
      });
    }

    const results = await txt2anm(query);

    res.status(200).json({
      status: true,
      creator: '7eppeli.XzC',
      query: query,
      data: results
    });

  } catch (error) {
    res.status(500).json({
      status: false,
      creator: '7eppeli.XzC',
      message: error.message || 'Internal server error'
    });
  }
});

app.get('/api/porn/xnxx', async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.trim() === '') {
      return res.status(400).json({
        status: false,
        creator: '7eppeli.XzC',
        message: 'Query parameter is required'
      });
    }

    const resultSearch = await xnxxs(query);
    const results = await xnxxdl(resultSearch.result[0].link)

    res.status(200).json({
      status: true,
      creator: '7eppeli.XzC',
      query: query,
      data: results
    });

  } catch (error) {
    res.status(500).json({
      status: false,
      creator: '7eppeli.XzC',
      message: error.message || 'Internal server error'
    });
  }
});

app.get('/api/porn/nekopoi', async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.trim() === '') {
      return res.status(400).json({
        status: false,
        creator: '7eppeli.XzC',
        message: 'Query parameter is required'
      });
    }

    const results = await nekos(query);

    res.status(200).json({
      status: true,
      creator: '7eppeli.XzC',
      query: query,
      data: results
    });

  } catch (error) {
    res.status(500).json({
      status: false,
      creator: '7eppeli.XzC',
      message: error.message || 'Internal server error'
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/upload', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/tourl.html'));
  express.static('uploads')
});

app.use((req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 - Page Not Found</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }

        body {
            height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            overflow: hidden;
            position: relative;
        }

        .container {
            text-align: center;
            z-index: 2;
            padding: 2rem;
            background: rgba(255, 255, 255, 0.05); /* Efek Kaca */
            backdrop-filter: blur(10px);
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 15px 35px rgba(0, 0, 0, 0.5);
            max-width: 500px;
            width: 90%;
        }

        .error-code {
            font-size: 8rem;
            font-weight: 800;
            color: #fff;
            line-height: 1;
            margin-bottom: 10px;
        }

        h1 {
            color: #fff;
            font-size: 1.5rem;
            margin-bottom: 10px;
            letter-spacing: 1px;
        }

        p {
            color: #ccc;
            margin-bottom: 30px;
            font-size: 1rem;
            line-height: 1.6;
        }

        .btn {
            text-decoration: none;
            color: #fff;
            padding: 12px 30px;
            border: 2px solid #fff;
            border-radius: 50px;
            font-weight: bold;
            text-transform: uppercase;
            transition: all 0.3s ease;
            display: inline-block;
            font-size: 0.9rem;
        }

        .btn:hover {
            background: #fff;
            color: #0f0c29;
            box-shadow: 0 0 20px rgba(255, 255, 255, 0.5);
        }

        @media (max-width: 600px) {
            .error-code {
                font-size: 5rem;
            }
            h1 {
                font-size: 1.2rem;
            }
        }
    </style>
</head>
<body>

    <div class="container">
        <div class="error-code">404</div>
        <h1>Not found</h1>
        <a href="/" class="btn">Return</a>
    </div>

</body>
</html>
  `)
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.message });
  } else if (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
