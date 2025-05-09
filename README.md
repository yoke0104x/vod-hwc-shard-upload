# vod-hwc-shard-upload
这是用来处理华为云vod视频上传的包

## 安装
```bash
npm install vod-hwc-shard-upload
```

## 使用
```ts
import { HuaweiVodUploader } from 'vod-hwc-shard-upload';

const uploader = new HuaweiVodUploader({
  projectId: 'your project id',
  region: 'your region',
  category_id: 'your category id',
  description: 'your description',
  bufferSize: 1024 * 1024,
  token: 'your token',
  fileType: 'your file type',
  fileContentType: 'your file content type',
});

uploader.upload({
  file: 'your file path',
  options: {
    fileType: "MP4",
    fileContentType: "video/mp4",
    onProgress: (progress) => {
      console.log(progress);
    }
  }
}).then((res) => {
  console.log(res);
}).catch((err) => {
  console.log(err);
});
```