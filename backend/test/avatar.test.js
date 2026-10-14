import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createAvatar, AVATAR_SIZE } from '../src/avatar.js';
import { AwsFaceProvider } from '../src/providers/aws-face.js';

const bounds = { Left: 0.7, Top: 0.2, Width: 0.2, Height: 0.4 };
async function sourceImage() {
  return sharp({ create: { width: 400, height: 200, channels: 3, background: '#ff0000' } })
    .composite([{ input: await sharp({ create: { width: 120, height: 120, channels: 3, background: '#0000ff' } }).png().toBuffer(), left: 260, top: 40 }])
    .jpeg().toBuffer();
}
test('crops the detected face instead of the centre and emits only a small JPEG', async () => {
  const original=await sourceImage();
  const thumbnail=Buffer.from(await createAvatar(original,bounds),'base64');
  const metadata=await sharp(thumbnail).metadata();
  assert.equal(metadata.width,AVATAR_SIZE); assert.equal(metadata.height,AVATAR_SIZE);
  assert.equal(metadata.format,'jpeg'); assert.equal(metadata.exif,undefined);
  const {data,info}=await sharp(thumbnail).raw().toBuffer({resolveWithObject:true});
  const offset=(48*info.width+48)*info.channels;
  assert(data[offset+2]>200 && data[offset]<30,'The thumbnail centre must contain the off-centre face region.');
  assert(original.some(byte=>byte!==0),'Do not erase the caller-owned registration image.');
});
test('honours JPEG EXIF orientation before applying the upright face bounds', async () => {
  const upright=await sourceImage();
  const rotated=await sharp(upright).rotate(-90).withMetadata({orientation:6}).jpeg().toBuffer();
  const thumbnail=Buffer.from(await createAvatar(rotated,bounds),'base64');
  const {data,info}=await sharp(thumbnail).raw().toBuffer({resolveWithObject:true});
  const offset=(48*info.width+48)*info.channels;
  assert(data[offset+2]>200 && data[offset]<30);
  assert.equal((await sharp(thumbnail).metadata()).orientation,undefined);
});
test('clamps edge boxes and handles legacy temporary captures without bounds',async()=> {
  const input=await sourceImage();
  for(const box of [undefined,{Left:-0.1,Top:-0.1,Width:1.3,Height:1.4}]) {
    const meta=await sharp(Buffer.from(await createAvatar(input,box),'base64')).metadata();
    assert.equal(meta.width,96); assert.equal(meta.height,96);
  }
  await assert.rejects(createAvatar(Buffer.from('invalid image'),bounds),{code:'INVALID_FACE_IMAGE',status:400});
});
test('capture retains internal crop bounds without adding them to public quality metrics',async()=> {
  const provider=new AwsFaceProvider({rekognitionRegion:'ap-northeast-1',collectionId:'test'}, {send:async()=>({FaceDetails:[{
    Confidence:100,Quality:{Brightness:90,Sharpness:90},Pose:{Yaw:0,Pitch:0,Roll:0},BoundingBox:bounds,
  }]})});
  const capture=await provider.captureImage((await sourceImage()).toString('base64'));
  assert.deepEqual(capture.boundingBox,bounds); assert(!('boundingBox' in capture.metrics));
  capture.image.fill(0);
});
