const object=(properties)=>({type:"object",properties,additionalProperties:false,minProperties:1});
const string={type:"string",maxLength:4096,pattern:"^[^\\u0000\\r\\n]*$"};
const flag={type:"boolean"};
const settingsSchema=object({
  AppearanceMode:{enum:["System","Light","Dark"]},ThemeHue:{type:"number",minimum:0,maximum:360},
  SidebarCollapsed:flag,IndependentWorlds:flag,GamePath:string,
  GameWindowSize:object({enabled:flag,width:{type:"integer",minimum:320,maximum:7680},height:{type:"integer",minimum:200,maximum:4320}}),
  ReloadKeys:object({reload_key:string,reload_world_key:string,reload_addon_key:string,reload_shaders_key:string,reload_key_global:flag}),
});
const projectSchema=object({
  user_name:{...string,minLength:1,maxLength:64},game_executable_path:string,
  included_mod_dirs:{type:"array",maxItems:200,items:{anyOf:[{...string,minLength:1},object({path:{...string,minLength:1},enabled:flag,hot_reload:flag})]}},
  include_debug_mod:flag,auto_hot_reload_mods:flag,auto_hot_reload_ui:flag,
  auto_hot_reload_shaders:flag,auto_hot_reload_materials:flag,auto_hot_reload_particles:flag,
  log_protocol:{enum:[0,1]},
});
const select=(value,schema)=>Object.fromEntries(Object.keys(schema.properties).filter(k=>Object.hasOwn(value||{},k)).map(k=>[k,schema.properties[k].properties?select(value[k],schema.properties[k]):value[k]]));
function projectView(snapshot) {
  const value={project:{id:snapshot.project.id,name:snapshot.project.name,root:snapshot.project.root},revision:snapshot.revision,config:select(snapshot.config,projectSchema),error:snapshot.error||null};
  // JSONC 的未知字段可能含私密配置；只呈现已声明的业务字段，不回传 raw。
  if(value.config.included_mod_dirs) value.config.included_mod_dirs=value.config.included_mod_dirs.map(x=>typeof x==="string"?x:select(x,projectSchema.properties.included_mod_dirs.items.anyOf[1]));
  return value;
}
module.exports={settingsSchema,projectSchema,select,projectView};
