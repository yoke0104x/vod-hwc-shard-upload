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
  accessKeyId: 'your access key id',
  accessKeySecret: 'your access key secret',
});

uploader.upload({
  file: 'your file path',
  fileName: 'your file name',
  fileType: 'your file type',
});
```

## 参数

| 参数 | 类型 | 描述 |
| --- | --- | --- |
