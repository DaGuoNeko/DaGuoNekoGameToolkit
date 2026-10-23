// Independent JsonUI geometry kernel. No imports, allocation or OS access.
// Inputs: parent, width fraction/pixels, height fraction/pixels,
// offset x fraction/pixels, offset y fraction/pixels, from x/y, to x/y,
// visible, layer, alpha, clips_children, stack axis (1=x, 2=y).
static constexpr int Limit = 20000, In = 18, Out = 11;
static float inputs[Limit * In], outputs[Limit * Out], flow[Limit];
static int count;
static float minf(float a,float b){return a<b?a:b;}
static float maxf(float a,float b){return a>b?a:b;}
extern "C" {
__attribute__((visibility("default"))) float* input_ptr(){return inputs;}
__attribute__((visibility("default"))) float* output_ptr(){return outputs;}
__attribute__((visibility("default"))) int layout(int n,float width,float height){
 if(n<0||n>Limit||width<=0||height<=0)return -1;
 count=n;
 for(int i=0;i<n;i++){
  float *v=inputs+i*In,*o=outputs+i*Out;int p=(int)v[0];
  if(p>=i||p< -1)return -1;
  float root[Out]={0,0,width,height,1,0,1,0,0,width,height};
  float *a=p<0?root:outputs+p*Out;
  o[2]=maxf(0,a[2]*v[1]+v[2]);o[3]=maxf(0,a[3]*v[3]+v[4]);
  o[0]=a[0]+a[2]*(v[9]+v[5])+v[6]-o[2]*v[11];
  o[1]=a[1]+a[3]*(v[10]+v[7])+v[8]-o[3]*v[12];
  if(p>=0){int axis=(int)inputs[p*In+17];
   if(axis==1){o[0]=a[0]+flow[p]+v[6];flow[p]+=o[2];}
   if(axis==2){o[1]=a[1]+flow[p]+v[8];flow[p]+=o[3];}
  }
  flow[i]=0;o[4]=a[4]&&v[13]!=0;o[5]=a[5]+v[14];
  o[6]=a[6]*minf(1,maxf(0,v[15]));
  for(int k=7;k<11;k++)o[k]=a[k];
  if(p>=0&&inputs[p*In+16]!=0){
   float right=minf(a[7]+a[9],a[0]+a[2]),bottom=minf(a[8]+a[10],a[1]+a[3]);
   o[7]=maxf(a[7],a[0]);o[8]=maxf(a[8],a[1]);
   o[9]=maxf(0,right-o[7]);o[10]=maxf(0,bottom-o[8]);
  }
 }
 return n;
}
__attribute__((visibility("default"))) int hit(float x,float y){
 int found=-1;float layer=-3.4e38f;
 for(int i=0;i<count;i++){float *r=outputs+i*Out;
  if(r[4]&&r[6]>0&&r[2]>0&&r[3]>0&&r[5]>=layer&&x>=r[0]&&y>=r[1]&&x<r[0]+r[2]&&y<r[1]+r[3]&&x>=r[7]&&y>=r[8]&&x<r[7]+r[9]&&y<r[8]+r[10]){found=i;layer=r[5];}
 }
 return found;
}
}
