use serde_json::{Value, json};

pub(super) fn material() -> listing_core::wb::Material {
    serde_json::from_value(json!({
        "subjectId":100,"language":"ru",
        "catalog":{"contentDigest":"sha256:wb","usable":true,"fields":[{
            "id":7,"name":"Color","required":true,"valueKind":1,"maxCount":1,
            "unitName":null,"popular":false,"hasFilter":true,"isVariable":true,
            "requiredForCreate":true,"namedField":false
        }]},
        "defaults":{"values":{"7":["blue"]},"revision":1,"validatedCatalogDigest":"sha256:wb"}
    }))
    .unwrap()
}

pub(super) fn config() -> listing_core::wb::WbProductConfig {
    serde_json::from_value(json!({
        "subjectId":100,"language":"ru","variants":[{"vendorCode":"A","characteristics":{},"cleared":[]}]
    })).unwrap()
}

fn put(bytes: &[u8]) -> *mut u8 {
    let ptr = listing_core_wasm::alloc(bytes.len());
    assert!(!ptr.is_null());
    // SAFETY: exact live allocation above, initialized before any ABI read.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
    ptr
}

pub(super) fn error() -> Value {
    // SAFETY: thread-local error storage is live until another ABI call.
    let bytes = unsafe {
        std::slice::from_raw_parts(
            listing_core_wasm::last_error_ptr(),
            listing_core_wasm::last_error_len() as usize,
        )
    };
    serde_json::from_slice(bytes).unwrap()
}

pub(super) fn load(input: &Value) -> Result<u32, Value> {
    let bytes = serde_json::to_vec(input).unwrap();
    let ptr = put(&bytes);
    // SAFETY: initialized input allocated above and held through this call.
    let handle = unsafe { listing_core_wasm::schema_load(ptr, bytes.len()) };
    // SAFETY: same allocation and length; schema_load does not retain it.
    unsafe { listing_core_wasm::free(ptr, bytes.len()) };
    if handle == 0 {
        Err(error())
    } else {
        Ok(handle)
    }
}

pub(super) fn load_wb(material: &listing_core::wb::Material) -> u32 {
    load(&json!({"platform":"wb","material":material})).unwrap()
}

pub(super) fn call(op: u32, handle: u32, input: &Value) -> Result<Vec<u8>, Value> {
    let bytes = serde_json::to_vec(input).unwrap();
    let ptr = put(&bytes);
    // SAFETY: initialized input allocated above and held through this call.
    let status = unsafe { listing_core_wasm::call(op, handle, ptr, bytes.len()) };
    // SAFETY: same allocation and length; call does not retain it.
    unsafe { listing_core_wasm::free(ptr, bytes.len()) };
    if status != 0 {
        return Err(error());
    }
    // SAFETY: result storage remains live until drop_result below.
    let result = unsafe {
        std::slice::from_raw_parts(
            listing_core_wasm::result_ptr(),
            listing_core_wasm::result_len() as usize,
        )
    }
    .to_vec();
    listing_core_wasm::drop_result();
    Ok(result)
}

pub(super) fn ozon() -> Value {
    json!({"snapshot":{
        "category_key":"wb-isolation","label":"isolation","description_category_id":100,
        "type_id":1,"schema_revision":"ozon","recipe_id":0,"recipe_revision":1,"catalog_schema_version":1,"fields":[]
    },"searchMaterials":[]})
}
