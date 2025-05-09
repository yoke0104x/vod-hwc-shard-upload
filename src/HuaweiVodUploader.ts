/**
 * 华为云VOD上传器类
 * 使用axios进行HTTP请求，spark-md5进行MD5计算
 */

// 定义参数类型接口
export interface UploaderOptions {
  projectId?: string;
  region?: string;
  category_id?: string;
  description?: string;
  bufferSize?: number;
  token?: string;
  fileType?: string;
  fileContentType?: string;
  onProgress?: (progress: ProgressInfo) => void;
}

// 定义进度回调接口
export interface ProgressInfo {
  loaded: number;
  total: number;
  percent: number;
}

// 定义上传信息接口
export interface UploadInfo {
  file: File;
  assetRsp: any;
  fileContentType: string;
  uploadId: string;
  headers: Record<string, string>;
  nextPartNumber: number;
  parts: Array<{ partNum: number, etag: string }>;
  totalChunks: number;
  uploadedSize: number;
}

// 定义上传状态类型
export type UploadStatusType = 'idle' | 'uploading' | 'paused' | 'stopped' | 'completed' | 'error';

// 声明外部依赖
import axios from 'axios';
import SparkMD5 from 'spark-md5';

class HuaweiVodUploader {
  // 基本配置属性
  private projectId: string = '0c5375b69b8010de2f1cc016ae1ee655';
  private region: string = 'cn-north-4';
  private token: string = '';
  private category_id: string = '';
  private description: string = '';
  private bufferSize: number;
  private urlList: Record<string, string>;
  private Uploading: boolean = false;
  
  // 上传控制状态
  public readonly uploadStatus = {
    IDLE: 'idle' as UploadStatusType,
    UPLOADING: 'uploading' as UploadStatusType,
    PAUSED: 'paused' as UploadStatusType,
    STOPPED: 'stopped' as UploadStatusType,
    COMPLETED: 'completed' as UploadStatusType,
    ERROR: 'error' as UploadStatusType
  };

  // 当前上传状态
  private currentStatus: UploadStatusType = 'idle';

  // 存储上传信息，用于暂停后继续
  private uploadInfo: UploadInfo | null = null;

  // 停止时的回调函数
  private onStopCallback: ((progress: ProgressInfo) => void) | null = null;
  
  // 当前进度
  private currentProgress: number = 0;

  /**
   * 构造函数
   * @param options 配置选项
   */
  constructor(options: UploaderOptions) {
    this.category_id = options.category_id || '';
    this.description = options.description || '';
    this.projectId = options.projectId || this.projectId;
    this.region = options.region || this.region;
    this.bufferSize = options.bufferSize || 1024 * 1024 * 100; // 默认100MB
    this.token = options.token || '';
    this.urlList = this.initUrl();
  }

  /**
   * 初始化API URL
   * @returns URL列表
   */
  private initUrl(): Record<string, string> {
    return {
      // 创建媒资接口
      createAssetUrl: `https://vod.${this.region}.myhuaweicloud.com/v1.0/${this.projectId}/asset`,
      // 获取授权接口
      initAuthUrl: `https://vod.${this.region}.myhuaweicloud.com/v1.0/${this.projectId}/asset/authority`,
      // 确认媒资上传接口
      confirmUploadedUrl: `https://vod.${this.region}.myhuaweicloud.com/v1.0/${this.projectId}/asset/status/uploaded`
    };
  }

  /**
   * 开始上传文件
   * @param file 要上传的文件
   * @param options 上传选项
   * @returns 上传结果Promise
   */
  public async upload(
    file: File, 
    options: UploaderOptions = {},
  ): Promise<any> {
    this.Uploading = true;

    return new Promise(async (resolve, reject) => {
      if (!this.Uploading) {
        console.warn('已有上传任务正在进行中');
        return;
      }

      // 如果正在上传或已完成，则不执行
      if (this.currentStatus === this.uploadStatus.UPLOADING) {
        console.warn('已有上传任务正在进行中');
        return;
      }

      this.currentStatus = this.uploadStatus.UPLOADING;
      // 保存进度回调，用于停止时重置进度
      this.onStopCallback = options?.onProgress || null;
      const onProgress = options?.onProgress;

      if (!this.token) {
        this.currentStatus = this.uploadStatus.ERROR;
        reject(new Error('获取token失败'));
        return;
      }

      try {
        // 设置文件类型，默认为MP4
        const fileType = options.fileType || 'MP4';
        const fileContentType = options.fileContentType || 'video/mp4';

        // 1. 设置请求头
        const headers = {
          'X-Auth-Token': this.token,
          'Content-Type': 'application/json'
        };
        console.log(this.token);

        // 2. 创建点播媒资
        const assetRsp = await this.createAsset(file.name, file.name, fileType, headers);

        // 3. 获取初始化上传任务授权
        const initAuthResponse = await this.getInitAuth(assetRsp, fileContentType, headers);

        // 4. 初始化分段上传任务
        const uploadId = await this.initPartUpload(initAuthResponse, assetRsp, fileContentType);

        // 保存上传信息，用于暂停后继续
        this.uploadInfo = {
          file,
          assetRsp,
          fileContentType,
          uploadId,
          headers,
          nextPartNumber: 1,
          parts: [],
          totalChunks: Math.ceil(file.size / this.bufferSize),
          uploadedSize: 0
        };

        // 5-6. 上传文件分段
        const partInfo = await this.uploadParts(onProgress);

        // 如果上传被停止，直接返回
        if (this.currentStatus === this.uploadStatus.STOPPED) {
          this.uploadInfo = null;
          return;
        }

        // 如果上传被暂停，等待恢复后继续
        if (this.currentStatus === this.uploadStatus.PAUSED) {
          return;
        }

        // 7-11. 完成上传
        await this.completeUpload(assetRsp, uploadId, partInfo, headers);

        // 12. 确认上传
        await this.confirmUploaded(assetRsp.asset_id, headers);

        this.currentStatus = this.uploadStatus.COMPLETED;
        this.uploadInfo = null;

        resolve(assetRsp);
      } catch (error) {
        this.currentStatus = this.uploadStatus.ERROR;
        reject(error);
      }
    });
  }

  /**
   * 暂停上传
   * @returns 是否成功暂停
   */
  public pauseUpload(): boolean {
    if (this.currentStatus !== this.uploadStatus.UPLOADING) {
      console.warn('没有正在进行的上传任务');
      return false;
    }

    this.currentStatus = this.uploadStatus.PAUSED;
    this.Uploading = false;
    return true;
  }

  /**
   * 恢复上传
   * @param onProgress 进度回调函数
   * @param onSuccess 成功回调函数
   * @param onError 错误回调函数
   * @returns 是否成功恢复
   */
  public resumeUpload(
    onProgress?: (progress: ProgressInfo) => void,
  ): boolean {
    if (this.currentStatus !== this.uploadStatus.PAUSED) {
      console.warn('没有可恢复的上传任务');
      return false;
    }

    this.currentStatus = this.uploadStatus.UPLOADING;
    this.Uploading = true;
    return true;
  }

  /**
   * 停止上传
   * @returns 是否成功停止
   */
  public stopUpload(): boolean {
    if (this.currentStatus !== this.uploadStatus.UPLOADING && 
        this.currentStatus !== this.uploadStatus.PAUSED) {
      console.warn('没有可停止的上传任务');
      return false;
    }

    this.currentStatus = this.uploadStatus.STOPPED;

    // 调用进度回调，将进度重置为0
    if (this.onStopCallback && this.uploadInfo) {
      this.onStopCallback({
        loaded: 0,
        total: this.uploadInfo.file.size,
        percent: 0
      });
    }

    // 清空上传信息
    this.uploadInfo = null;
    this.onStopCallback = null;
    this.Uploading = false;
    return true;
  }

  /**
   * 获取当前上传状态
   * @returns 当前状态
   */
  public getUploadStatus(): UploadStatusType {
    return this.currentStatus;
  }

  /**
   * 创建点播媒资
   * @param title 标题
   * @param videoName 视频名称
   * @param videoType 视频类型
   * @param headers 请求头
   * @returns 创建结果
   */
  private async createAsset(
    title: string, 
    videoName: string, 
    videoType: string, 
    headers: Record<string, string>
  ): Promise<any> {
    const body = {
      title: title,
      video_name: videoName,
      video_type: videoType,
      category_id: this.category_id,
      description: this.description
    };

    const response = await axios.post(this.urlList.createAssetUrl, body, { headers });
    return response.data;
  }

  /**
   * 获取上传初始化任务授权
   * @param assetRsp 媒资响应
   * @param fileContentType 文件内容类型
   * @param headers 请求头
   * @returns 授权结果
   */
  private async getInitAuth(
    assetRsp: any, 
    fileContentType: string, 
    headers: Record<string, string>
  ): Promise<any> {
    const params = {
      http_verb: 'POST',
      content_type: fileContentType,
      bucket: assetRsp.target.bucket,
      object_key: assetRsp.target.object
    };

    let queryString = '?';
    for (const key in params) {
      queryString += `${key}=${params[key as keyof typeof params]}&`;
    }

    const response = await axios.get(this.urlList.initAuthUrl + queryString, { headers });
    return response.data;
  }

  /**
   * 初始化分段上传
   * @param signStr 签名字符串
   * @param assetRsp 媒资响应
   * @param contentType 内容类型
   * @returns 上传ID
   */
  private async initPartUpload(
    signStr: any, 
    assetRsp: any, 
    contentType: string
  ): Promise<string> {
    const initUrl = `https://${assetRsp.target.bucket}.obs.${this.region}.myhuaweicloud.com/${assetRsp.target.object}?uploads&${signStr.sign_str}`;

    const headers = { 'Content-Type': contentType };
    const response = await axios.post(initUrl, null, { headers });

    // 解析XML响应
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(response.data, 'text/xml');
    const uploadIdElement = xmlDoc.getElementsByTagName('UploadId')[0];
    return uploadIdElement?.textContent || '';
  }

  /**
   * 获取分段上传授权
   * @param assetRsp 媒资响应
   * @param fileContentType 文件内容类型
   * @param uploadId 上传ID
   * @param contentMd5 内容MD5
   * @param partNumber 分段编号
   * @param headers 请求头
   * @returns 授权结果
   */
  private async getPartUploadAuthority(
    assetRsp: any, 
    fileContentType: string, 
    uploadId: string, 
    contentMd5: string, 
    partNumber: number, 
    headers: Record<string, string>
  ): Promise<any> {
    const params = {
      http_verb: 'PUT',
      content_type: fileContentType,
      bucket: assetRsp.target.bucket,
      object_key: assetRsp.target.object,
      content_md5: encodeURIComponent(contentMd5),
      upload_id: uploadId,
      part_number: partNumber
    };
    
    let temp = "?";
    for (const key in params) {
      temp += key + "=" + params[key as keyof typeof params] + "&";
    }

    const response = await axios.get(this.urlList.initAuthUrl + temp, { headers });
    return response.data;
  }

  /**
   * 上传分段
   * @param uploadAuth 上传授权
   * @param assetRsp 媒资响应
   * @param contentMd5 内容MD5
   * @param partNumber 分段编号
   * @param uploadId 上传ID
   * @param content 分段内容
   * @param onUploadProgress 上传进度回调
   */
  private async uploadPartFile(
    uploadAuth: any, 
    assetRsp: any, 
    contentMd5: string, 
    partNumber: number, 
    uploadId: string, 
    content: Blob,
    onUploadProgress?: (percent: number) => void
  ): Promise<void> {
    console.log(uploadAuth, assetRsp, contentMd5, partNumber, uploadId, content);
    const url = `https://${assetRsp.target.bucket}.obs.${this.region}.myhuaweicloud.com/${assetRsp.target.object}?partNumber=${partNumber}&uploadId=${uploadId}&${uploadAuth.sign_str}`;

    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-MD5': contentMd5,
      'X-Auth-Token': this.token,
    };

    await axios.put(url, content, {
      headers, 
      onUploadProgress: (progress) => {
        if (onUploadProgress && progress.total) {
          onUploadProgress(Math.round((progress.loaded / content.size) * 100));
        }
      }
    });
  }

  /**
   * 上传所有分段
   * @param onProgress 进度回调
   * @returns 分段信息
   */
  private async uploadParts(
    onProgress?: (progress: ProgressInfo) => void
  ): Promise<string | null> {
    if (!this.uploadInfo) {
      throw new Error('上传信息不存在');
    }

    const {
      file,
      assetRsp,
      fileContentType,
      uploadId,
      headers,
      nextPartNumber,
      parts,
      totalChunks,
      uploadedSize
    } = this.uploadInfo;

    // 从上次暂停的位置继续上传
    for (let partNum = nextPartNumber; partNum <= totalChunks; partNum++) {
      // 检查上传状态
      if (this.currentStatus === this.uploadStatus.PAUSED) {
        // 更新下一个要上传的分片编号
        this.uploadInfo.nextPartNumber = partNum;
        return this.buildPartInfo(parts);
      }

      if (this.currentStatus === this.uploadStatus.STOPPED) {
        return null;
      }

      const start = (partNum - 1) * this.bufferSize;
      const end = Math.min(start + this.bufferSize, file.size);
      const chunk = file.slice(start, end);

      // 读取chunk为ArrayBuffer
      const arrayBuffer = await this.readFileAsArrayBuffer(chunk);

      // 计算MD5
      const md5 = await this.calculateMd5(arrayBuffer);
      // MD5转base64
      const contentMd5 = this.arrayBufferToBase64(md5);

      // 获取分段上传授权
      const uploadAuth = await this.getPartUploadAuthority(
        assetRsp, fileContentType, uploadId, contentMd5, partNum, headers
      );

      // 上传分段
      await this.uploadPartFile(uploadAuth, assetRsp, contentMd5, partNum, uploadId, chunk, (value) => {
        console.log(this.currentProgress, Math.floor(value / totalChunks), '.......');
        if (onProgress) {
          onProgress({
            loaded: end,
            total: file.size,
            percent: this.currentProgress + Math.floor(value / totalChunks)
          });
        }
      });

      // 保存分段信息
      parts.push({ partNum, etag: contentMd5 });

      // 更新已上传大小
      this.uploadInfo.uploadedSize = end;
      this.currentProgress = Math.round((end / file.size) * 100);
      
      // 回调上传进度
      if (onProgress) {
        onProgress({
          loaded: end,
          total: file.size,
          percent: Math.round((end / file.size) * 100)
        });
      }
    }

    // 构建合并段的参数
    return null;
  }

  /**
   * 将文件读取为ArrayBuffer
   * @param file 文件块
   * @returns ArrayBuffer
   */
  private readFileAsArrayBuffer(file: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        if (e.target && e.target.result) {
          resolve(e.target.result as ArrayBuffer);
        } else {
          reject(new Error('读取文件失败'));
        }
      };
      reader.onerror = e => reject(e);
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * 使用SparkMD5计算MD5
   * @param arrayBuffer 数组缓冲区
   * @returns MD5 ArrayBuffer
   */
  private async calculateMd5(arrayBuffer: ArrayBuffer): Promise<ArrayBuffer> {
    return new Promise((resolve) => {
      const spark = new SparkMD5.ArrayBuffer();
      spark.append(arrayBuffer);
      const md5Hex = spark.end();
      resolve(this.hexToArrayBuffer(md5Hex));
    });
  }

  /**
   * 将十六进制字符串转换为ArrayBuffer
   * @param hex 十六进制字符串
   * @returns ArrayBuffer
   */
  private hexToArrayBuffer(hex: string): ArrayBuffer {
    const len = hex.length / 2;
    const bytes = new Uint8Array(len);

    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }

    return bytes.buffer;
  }

  /**
   * 将ArrayBuffer转换为Base64
   * @param buffer 数组缓冲区
   * @returns Base64字符串
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * 构建分段信息
   * @param parts 分段列表
   * @returns 分段信息XML
   */
  private buildPartInfo(parts: Array<{ partNum: number, etag: string }>): string {
    let result = '<CompleteMultipartUpload>';

    parts.forEach(part => {
      result += `<Part>` +
        `<PartNumber>${part.partNum}</PartNumber>` +
        `<ETag>${part.etag}</ETag>` +
        `</Part>`;
    });

    result += '</CompleteMultipartUpload>';
    return result;
  }

  /**
   * 获取列举分段上传授权
   * @param assetRsp 媒资响应
   * @param uploadId 上传ID
   * @param headers 请求头
   * @returns 授权结果
   */
  private async listUploadedPartAuthority(
    assetRsp: any, 
    uploadId: string, 
    headers: Record<string, string>
  ): Promise<any> {
    const params = {
      http_verb: 'GET',
      bucket: assetRsp.target.bucket,
      object_key: assetRsp.target.object,
      upload_id: uploadId
    };

    let queryString = '?';
    for (const key in params) {
      queryString += `${key}=${params[key as keyof typeof params]}&`;
    }

    const response = await axios.get(this.urlList.initAuthUrl + queryString, { headers });
    return response.data;
  }

  /**
   * 查询已上传的分段
   * @param signStr 签名字符串
   * @param assetRsp 媒资响应
   * @param uploadId 上传ID
   * @returns 分段信息
   */
  private async listUploadedPart(
    signStr: string, 
    assetRsp: any, 
    uploadId: string
  ): Promise<string> {
    const url = `https://${assetRsp.target.bucket}.obs.${this.region}.myhuaweicloud.com/${assetRsp.target.object}?${signStr}&uploadId=${uploadId}`;
    let nextPartNumberMarker = 0;
    let result = '<CompleteMultipartUpload>';
    
    const response = await axios.get(`${url}`);
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(response.data, 'text/xml');
    const parts = xmlDoc.getElementsByTagName('Part');
    console.log(parts, '.......');
    
    for (let i = 0; i < parts.length; i++) {
      const ele = parts[i];
      const numElement = ele.getElementsByTagName('PartNumber')[0];
      const tagElement = ele.getElementsByTagName('ETag')[0];
      
      if (numElement && tagElement) {
        const num = numElement.textContent || '';
        const tag = tagElement.textContent || '';
        
        result += `<Part>` +
          `<PartNumber>${num}</PartNumber>` +
          `<ETag>${tag}</ETag>` +
          `</Part>`;
      }
    }
    
    result += '</CompleteMultipartUpload>';
    return result;
  }

  /**
   * 获取合并段授权
   * @param assetRsp 媒资响应
   * @param uploadId 上传ID
   * @param headers 请求头
   * @returns 授权结果
   */
  private async mergeUploadedPartAuthority(
    assetRsp: any, 
    uploadId: string, 
    headers: Record<string, string>
  ): Promise<any> {
    const params = {
      http_verb: 'POST',
      bucket: assetRsp.target.bucket,
      object_key: assetRsp.target.object,
      upload_id: uploadId
    };

    let queryString = '?';
    for (const key in params) {
      queryString += `${key}=${params[key as keyof typeof params]}&`;
    }

    const response = await axios.get(this.urlList.initAuthUrl + queryString, { headers });
    return response.data;
  }

  /**
   * 合并段
   * @param signStr 签名字符串
   * @param partInfo 分段信息
   * @param assetRsp 媒资响应
   * @param uploadId 上传ID
   */
  private async mergeUploadedPart(
    signStr: string, 
    partInfo: string, 
    assetRsp: any, 
    uploadId: string
  ): Promise<void> {
    const url = `https://${assetRsp.target.bucket}.obs.${this.region}.myhuaweicloud.com/${assetRsp.target.object}?${signStr}&uploadId=${uploadId}`;

    await axios.post(url, partInfo, {
      headers: { 'Content-Type': 'application/xml' }
    });
  }

  /**
   * 获取上传片段列表
   * @param assetRsp 媒资响应
   * @param uploadId 上传ID
   * @param headers 请求头
   * @returns 片段信息
   */
  private async getUploadChunkList(
    assetRsp: any, 
    uploadId: string, 
    headers: Record<string, string>
  ): Promise<string> {
    const listAuthResp = await this.listUploadedPartAuthority(assetRsp, uploadId, headers);
    // 列举已上传段
    return await this.listUploadedPart(listAuthResp.sign_str, assetRsp, uploadId);
  }

  /**
   * 完成上传
   * @param assetRsp 媒资响应
   * @param uploadId 上传ID
   * @param partInfo 分段信息
   * @param headers 请求头
   */
  private async completeUpload(
    assetRsp: any, 
    uploadId: string, 
    partInfo: string | null, 
    headers: Record<string, string>
  ): Promise<void> {
    partInfo = await this.getUploadChunkList(assetRsp, uploadId, headers);

    // 获取合并段授权
    const mergeAuthResp = await this.mergeUploadedPartAuthority(assetRsp, uploadId, headers);

    // 合并段
    await this.mergeUploadedPart(mergeAuthResp.sign_str, partInfo, assetRsp, uploadId);
  }

  /**
   * 确认上传
   * @param assetId 媒资ID
   * @param headers 请求头
   * @returns 确认结果
   */
  private async confirmUploaded(
    assetId: string, 
    headers: Record<string, string>
  ): Promise<any> {
    const body = {
      asset_id: assetId,
      status: 'CREATED'
    };

    const response = await axios.post(this.urlList.confirmUploadedUrl, body, { headers });
    return response.data;
  }
}

// 导出类
export default HuaweiVodUploader; 